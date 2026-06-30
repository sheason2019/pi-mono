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

async function startHubWithAuth(workspaceRoot: string): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "rc-test", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-rc-test",
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

describe("hub endpoint POST /agents/{id}/remote-call", () => {
	beforeEach(() => {
		createTempDir("d-pi-remote-call-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("dispatches a remote-call to the bound executor and returns the result", async () => {
		const { url, gateway, executorRegistry, sessionToken } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			// Pre-attach a fake sseConn directly (simulating that the executor
			// already opened the SSE and is ready to receive commands).
			const received: Array<{ event: string; data: unknown }> = [];
			executorRegistry.attachSse("c1", {
				send: (event, data) => {
					received.push({ event, data });
					// Immediately POST a result back to resolve the pending call.
					const port = new URL(url).port;
					const payload = data as { callId: string };
					void fetch(`http://127.0.0.1:${port}/api/executor/results`, {
						method: "POST",
						headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
						body: JSON.stringify({
							connectId: "c1",
							callId: payload.callId,
							ok: true,
							result: { output: "ls done" },
						}),
					});
				},
			});
			gateway.bindAgent("agent-1", "c1");

			const res = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "call-1", tool: "bash", params: { command: "ls" } }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, result: { output: "ls done" } });
			expect(received).toHaveLength(1);
			expect(received[0].event).toBe("remote-call");
			expect(received[0].data).toEqual({ callId: "call-1", tool: "bash", params: { command: "ls" } });
		} finally {
			await gateway.stop();
		}
	});

	it("returns 409 when the agent is not bound to a connect id", async () => {
		const { url, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/agents/agent-orphan/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "call-1", tool: "bash" }),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not in connect mode/i) });
		} finally {
			await gateway.stop();
		}
	});

	it("returns 409 when the bound executor is not (yet) registered", async () => {
		const { url, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			gateway.bindAgent("agent-2", "missing-executor");
			const res = await fetch(`${url}/agents/agent-2/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "call-1", tool: "bash" }),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ error: expect.stringMatching(/executor not available/i) });
		} finally {
			await gateway.stop();
		}
	});

	it("returns 400 on missing fields", async () => {
		const { url, sessionToken, gateway, executorRegistry } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			gateway.bindAgent("agent-3", "c1");
			const res = await fetch(`${url}/agents/agent-3/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "call-1" }),
			});
			expect(res.status).toBe(400);
		} finally {
			await gateway.stop();
		}
	});

	it("unbindAgent removes the binding", async () => {
		const { url, sessionToken, gateway, executorRegistry } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			gateway.bindAgent("agent-4", "c1");
			gateway.unbindAgent("agent-4");
			const res = await fetch(`${url}/agents/agent-4/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "call-1", tool: "bash" }),
			});
			expect(res.status).toBe(409);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 401 when no bearer token is supplied (regression for unauthenticated RCE)", async () => {
		const { url, gateway, executorRegistry } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			executorRegistry.attachSse("c1", { send: () => {} });
			gateway.bindAgent("agent-1", "c1");

			const res = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
			});
			expect(res.status).toBe(401);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 401 when the bearer token is wrong", async () => {
		const { url, gateway, executorRegistry } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			executorRegistry.attachSse("c1", { send: () => {} });
			gateway.bindAgent("agent-1", "c1");

			const res = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
			});
			expect(res.status).toBe(401);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 409 when the executor is pre-registered but its SSE is not yet attached (race fix)", async () => {
		// Reproduce: the connect parent binds the agent before spawning the
		// executor, so a remote-call can arrive during the preRegister-only
		// window. The hub should fail fast instead of parking the call in
		// pendingCalls (where it would hang until the per-call timeout).
		const { url, sessionToken, gateway, executorRegistry } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			// Note: deliberately NOT calling attachSse.
			gateway.bindAgent("agent-1", "c1");

			const res = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { error: string };
			expect(body.error).toMatch(/not yet ready/i);
			// And the call should NOT be parked in pendingCalls.
			expect(executorRegistry.resolveOne("c1", "c-1", { ok: true, result: null })).toBe(false);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 504 when the executor never POSTs a result (per-call timeout)", async () => {
		// Build a hub with a 50ms remote-call timeout so the test is fast.
		const workspaceRoot = tempDir!;
		const localUser = createLocalUser(workspaceRoot, { name: "rc-test", description: "" });
		createAllowedUser(workspaceRoot, {
			name: "allowed-rc-test",
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
			{ remoteCallTimeoutMs: 50 },
		);
		await gateway.start(0);
		const url = gateway.url();
		try {
			const ch = (await (
				await fetch(`${url}/api/auth/challenge`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ publicKey: localUser.publicKey }),
				})
			).json()) as { challengeId: string; challenge: string };
			const session = (await (
				await fetch(`${url}/api/auth/session`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						publicKey: localUser.publicKey,
						challengeId: ch.challengeId,
						signature: signChallenge(localUser, ch.challenge),
					}),
				})
			).json()) as { token: string };
			const sessionToken = session.token;

			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			// attachSse but never call sendResult. The fake send is a
			// no-op so the executor never resolves the call.
			executorRegistry.attachSse("c1", { send: () => {} });
			gateway.bindAgent("agent-1", "c1");

			const start = Date.now();
			const res = await fetch(`${url}/agents/agent-1/remote-call`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
			});
			const elapsed = Date.now() - start;

			expect(res.status).toBe(504);
			const body = (await res.json()) as { ok: boolean; error: string };
			expect(body.ok).toBe(false);
			expect(body.error).toMatch(/timed out/i);
			// Should have failed around the 50ms timeout, not hung.
			expect(elapsed).toBeGreaterThanOrEqual(40);
			expect(elapsed).toBeLessThan(2_000);
			// And the pending entry was cleared.
			expect(executorRegistry.resolveOne("c1", "c-1", { ok: true, result: null })).toBe(false);
		} finally {
			await gateway.stop();
		}
	}, 5000);
});
