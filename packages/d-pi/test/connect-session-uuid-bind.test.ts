import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";

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
	let baseUrl: string;

	beforeEach(async () => {
		workspaceRoot = mkdtempSync(join(tmpdir(), "d-pi-bind-"));
		registry = new AgentRegistry();
		// Pre-create a fake "root" agent so the bind endpoint can be hit
		// without the hub's createAgent dance. allocatePort on main
		// is a 0-arg helper that picks the next free port; the
		// returned value is for the registry's internal tracking.
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
		await gateway.start(0);
		baseUrl = gateway.url();
	});

	afterEach(async () => {
		await gateway.stop();
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
		expect(body).toContain('"ok":true');
		expect(gateway.getBinding("root")).toBe("session-A");
	});

	it("decodes encoded agent names for bind and unbind keys", async () => {
		const bindResult = await bind("root%20agent", "connect-1");
		expect(bindResult.status).toBe(200);
		expect(gateway.getBinding("root agent")).toBe("connect-1");

		const unbindResult = await unbind("root%20agent");
		expect(unbindResult.status).toBe(200);
		expect(gateway.getBinding("root agent")).toBeUndefined();
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
