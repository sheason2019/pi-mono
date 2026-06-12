import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/hub/hub.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { SourceValidator } from "../src/hub/source-validator.ts";
import { AuthSessionManager } from "../src/auth/allowed-users.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Tests for the "connectId is per-session, not per-agent" change.
 *
 * History: connect-mode.ts used to pass `currentAgentName` as the
 * connectId, so the hub's ExecutorRegistry (keyed by connectId)
 * would reject the second `d-pi connect` for the same agent with
 * "Connect id already registered: <agent>". The fix is two-part:
 *
 *   1. connect-mode.ts now generates a fresh UUID per session and
 *      passes that as connectId.
 *   2. The hub's `/agents/{id}/bind` endpoint silently unbind the
 *      previous binding for that agent before installing the new one,
 *      so a stale session on another machine doesn't permanently
 *      shadow the new session.
 *
 * This test exercises the bind endpoint directly to confirm the
 * overwrite semantics work, and exercises the registry through the
 * full bind + unbind cycle to confirm there's no leak.
 */
describe("connectId is per-session (not per-agent)", () => {
	let registry: AgentRegistry;
	let sourceManager: SourceManager;
	let executorRegistry: ExecutorRegistry;
	let gateway: HubGateway;
	let workspaceRoot: string;
	let server: ReturnType<typeof createServer>;
	let baseUrl: string;

	beforeEach(async () => {
		workspaceRoot = mkdtempSync(join(tmpdir(), "d-pi-bind-"));
		registry = new AgentRegistry(40000);
		// Pre-create a fake "root" agent so the bind endpoint can be hit
		// without the hub's createAgent dance.
		registry.allocatePort("root");
		registry.updateStatus("root", "ready");
		sourceManager = new SourceManager(
			(_sourceName, _line, _subscriberIds, _mode) => {
				/* no-op */
			},
			{ workspaceRoot },
		);
		executorRegistry = new ExecutorRegistry();
		gateway = new HubGateway(
			registry,
			sourceManager,
			async () => {
				throw new Error("createAgent should not be called in this test");
			},
			async () => {
				/* no-op */
			},
			undefined,
			executorRegistry,
		);
		// gateway.handle() doesn't exist as a public method on the
		// class — the class wires its own HTTP server in start().
		// For the test we manually route to the internal handler.
		// The handler is exposed as `_handleHubApi`; we still need
		// the URL parsing + auth (which start() does for free), so
		// use a small inline shim that mimics it.
		server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const path = url.pathname;
			// Mirror the small slice of start() we need.
			(gateway as unknown as { _handleHubApi: (req: typeof req, res: typeof res, path: string) => Promise<void> })._handleHubApi(
				req,
				res,
				path,
			).catch((err: unknown) => {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(workspaceRoot, { recursive: true, force: true });
	});

	async function bind(agentName: string, connectId: string): Promise<{ status: number; body: string }> {
		const res = await fetch(`${baseUrl}/_hub/agents/${agentName}/bind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ connectId }),
		});
		return { status: res.status, body: await res.text() };
	}

	async function unbind(agentName: string): Promise<{ status: number }> {
		const res = await fetch(`${baseUrl}/_hub/agents/${agentName}/unbind`, {
			method: "POST",
		});
		return { status: res.status };
	}

	it("first bind for an agent succeeds and records the connectId", async () => {
		const { status, body } = await bind("root", "session-A");
		expect(status).toBe(200);
		expect(body).toContain("\"ok\":true");
		expect(gateway.getBinding("root")).toBe("session-A");
	});

	it("second bind for the SAME agent with a DIFFERENT connectId overwrites the old binding (does not 409)", async () => {
		// Two machines independently call bind("root", <their own UUID>).
		// The first call's UUID must not block the second.
		const first = await bind("root", "session-A-from-machine-1");
		expect(first.status).toBe(200);
		expect(gateway.getBinding("root")).toBe("session-A-from-machine-1");

		// The second session takes over. This is the regression we're
		// testing for — the old code would NOT have a bind-overwrite
		// path at all (and would have hit "Connect id already
		// registered" on the executor side, but the bind endpoint
		// itself always set unconditionally). Now we explicitly
		// unbind-then-bind so the new session is authoritative.
		const second = await bind("root", "session-B-from-machine-2");
		expect(second.status).toBe(200);
		expect(gateway.getBinding("root")).toBe("session-B-from-machine-2");
	});

	it("after overwrite, the OLD connectId's executor registry entry is NOT auto-cleaned (it stays until its SSE closes)", async () => {
		// The bind endpoint can't reach into the executor registry
		// directly — only the bind/unbind methods. The dropped
		// session's executor, if still alive, will exit on its own
		// when its next remote call routes to the wrong connectId
		// (or when its SSE channel closes). So we expect the old
		// executor entry to remain in the registry until explicit
		// cleanup — this is documented behaviour, not a leak per se.
		// Pre-register two entries directly to simulate the
		// executors having registered themselves.
		executorRegistry.preRegister("old-session-uuid", { cwd: workspaceRoot });
		executorRegistry.preRegister("new-session-uuid", { cwd: workspaceRoot });
		await bind("root", "old-session-uuid");
		await bind("root", "new-session-uuid");
		// Both entries are still in the executor registry; the
		// "old" one is stale but not yet removed.
		expect(executorRegistry.get("old-session-uuid")).toBeDefined();
		expect(executorRegistry.get("new-session-uuid")).toBeDefined();
		// A third bind with yet another UUID also succeeds.
		const third = await bind("root", "third-session-uuid");
		expect(third.status).toBe(200);
		expect(gateway.getBinding("root")).toBe("third-session-uuid");
	});

	it("unbind clears the agent binding but does NOT touch the executor registry entry", async () => {
		await bind("root", "session-A");
		expect(gateway.getBinding("root")).toBe("session-A");
		executorRegistry.preRegister("session-A", { cwd: workspaceRoot });
		expect(executorRegistry.get("session-A")).toBeDefined();
		// Executor registry is populated separately (by the
		// executor's own preRegister call) — not by the bind
		// endpoint. So unbind clears the agent binding, but the
		// executor entry (if any) survives until SSE close.
		const result = await unbind("root");
		expect(result.status).toBe(200);
		expect(gateway.getBinding("root")).toBeUndefined();
		// Executor registry entry is still there.
		expect(executorRegistry.get("session-A")).toBeDefined();
	});

	it("connectId validation: missing connectId is rejected with 400", async () => {
		const res = await fetch(`${baseUrl}/_hub/agents/root/bind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/connectId is required/);
	});
});

// Touch SourceValidator so its import is exercised (some bundlers
// tree-shake transitive imports and fail to compile if a path is
// unused). It's not actually called here — the test path only
// exercises the gateway + registry — but having the import keeps
// the build deterministic.
void SourceValidator;
