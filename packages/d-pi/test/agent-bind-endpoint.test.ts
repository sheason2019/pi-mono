import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

interface StartedHub {
	url: string;
	gateway: HubGateway;
	executorRegistry: ExecutorRegistry;
	sessionToken: string;
}

async function startHub(workspaceRoot: string): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "bind-test", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-bind-test",
		description: "",
		publicKey: localUser.publicKey,
	});
	const executorRegistry = new ExecutorRegistry();
	const gateway = new HubGateway(
		new AgentRegistry(),
		async () => ({ agentName: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
		executorRegistry,
	);
	await gateway.start(0);
	const challenge = (await (
		await fetch(`${gateway.url()}/api/auth/challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicKey: localUser.publicKey }),
		})
	).json()) as { challengeId: string; challenge: string };
	const session = (await (
		await fetch(`${gateway.url()}/api/auth/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				publicKey: localUser.publicKey,
				challengeId: challenge.challengeId,
				signature: signChallenge(localUser, challenge.challenge),
			}),
		})
	).json()) as { token: string };
	return { url: gateway.url(), gateway, executorRegistry, sessionToken: session.token };
}

describe("hub endpoint POST /api/agents/{name}/bind", () => {
	beforeEach(() => {
		createTempDir("d-pi-agent-bind-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("binds an agent to a connect id and the binding survives until unbind", async () => {
		const { url, gateway, sessionToken } = await startHub(tempDir!);
		try {
			const res = await fetch(`${url}/api/agents/agent-1/bind`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "connect-1" }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });

			// Bind is reflected in the gateway's internal state. Probe via
			// /agents/agent-1/remote-call: with the binding set but no executor
			// registered, the gateway should answer 409 "Executor not available"
			// (meaning it found the binding and tried to dispatch). Without the
			// binding, it would answer 409 "Agent not in connect mode".
			const callRes = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
			});
			expect(callRes.status).toBe(409);
			const body = (await callRes.json()) as { error: string };
			expect(body.error).toMatch(/Executor not available/i);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 400 when connectId is missing", async () => {
		const { url, gateway, sessionToken } = await startHub(tempDir!);
		try {
			const res = await fetch(`${url}/api/agents/agent-1/bind`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/connectId/);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 401 without auth", async () => {
		const { url, gateway } = await startHub(tempDir!);
		try {
			const res = await fetch(`${url}/api/agents/agent-1/bind`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c-1" }),
			});
			expect(res.status).toBe(401);
		} finally {
			await gateway.stop();
		}
	});

	it("unbind removes the binding so /remote-call answers 409 with the right error", async () => {
		const { url, gateway, sessionToken } = await startHub(tempDir!);
		try {
			await fetch(`${url}/api/agents/agent-1/bind`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c-1" }),
			});

			const unbind = await fetch(`${url}/api/agents/agent-1/unbind`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}` },
			});
			expect(unbind.status).toBe(200);
			expect(await unbind.json()).toEqual({ ok: true });

			const callRes = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
			});
			expect(callRes.status).toBe(409);
			expect(((await callRes.json()) as { error: string }).error).toMatch(/not in connect mode/i);
		} finally {
			await gateway.stop();
		}
	});

	it("unbindByConnectId drops every binding pointing at that connectId", () => {
		// We need a real gateway; build one inline.
		// (Auxiliary test; reuses the startHub helper indirectly via the
		// gateway created in the beforeEach of the enclosing describe. We
		// inline a small new gateway to keep the assertion self-contained.)
		const g = new HubGateway(
			new AgentRegistry(),
			async () => ({ agentName: "x" }),
			async () => {},
		);
		g.bindAgent("agent-1", "c1");
		g.bindAgent("agent-2", "c2");
		g.bindAgent("agent-3", "c1");
		expect(g.bindingCount).toBe(3);
		const removed = g.unbindByConnectId("c1");
		expect(removed).toBe(2);
		expect(g.bindingCount).toBe(1);
		expect(g.getBinding("agent-2")).toBe("c2");
	});

	it("SSE close handler GCs bindings for the disconnecting connectId", async () => {
		// Build a hub with a real executor registry, register a binding,
		// open an SSE channel, then close it. The binding should be cleared.
		const { AgentRegistry: AR } = await import("../src/hub/agent-registry.ts");
		const { ExecutorRegistry } = await import("../src/hub/executor-registry.ts");
		void AR;
		const localUser = createLocalUser(tempDir!, { name: "m4-test", description: "" });
		createAllowedUser(tempDir!, {
			name: "allowed-m4-test",
			description: "",
			publicKey: localUser.publicKey,
		});
		const execReg = new ExecutorRegistry();
		const gw = new HubGateway(
			new AR(),
			async () => ({ agentName: "x" }),
			async () => {},
			new AuthSessionManager(tempDir!),
			execReg,
		);
		await gw.start(0);
		try {
			// Pre-register, bind, then open the SSE channel.
			execReg.preRegister("c1", { cwd: "/tmp" });
			gw.bindAgent("agent-1", "c1");
			expect(gw.getBinding("agent-1")).toBe("c1");

			const ch = (await (
				await fetch(`${gw.url()}/api/auth/challenge`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ publicKey: localUser.publicKey }),
				})
			).json()) as { challengeId: string; challenge: string };
			const session = (await (
				await fetch(`${gw.url()}/api/auth/session`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						publicKey: localUser.publicKey,
						challengeId: ch.challengeId,
						signature: signChallenge(localUser, ch.challenge),
					}),
				})
			).json()) as { token: string };

			// Open SSE then close immediately. We use AbortController to
			// tear down the connection so the close handler runs.
			const ctrl = new AbortController();
			const sseRes = await fetch(`${gw.url()}/api/executor/events?connectId=c1`, {
				headers: { Authorization: `Bearer ${session.token}` },
				signal: ctrl.signal,
			});
			expect(sseRes.status).toBe(200);
			await sseRes.body?.cancel();
			ctrl.abort();
			// Allow the close handler to run.
			await new Promise((r) => setTimeout(r, 50));
			expect(gw.getBinding("agent-1")).toBeUndefined();
			expect(execReg.get("c1")).toBeUndefined();
		} finally {
			await gw.stop();
		}
	});
});
