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
import { SourceManager } from "../src/hub/source-manager.ts";

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
		new AgentRegistry(0),
		new SourceManager(() => {}),
		async () => ({ agentId: "created", name: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
		executorRegistry,
	);
	await gateway.start(0);
	const challenge = (await (
		await fetch(`${gateway.url()}/_hub/auth/challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicKey: localUser.publicKey }),
		})
	).json()) as { challengeId: string; challenge: string };
	const session = (await (
		await fetch(`${gateway.url()}/_hub/auth/session`, {
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

describe("hub endpoint POST /_hub/agents/{id}/bind", () => {
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
			const res = await fetch(`${url}/_hub/agents/agent-1/bind`, {
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
			const res = await fetch(`${url}/_hub/agents/agent-1/bind`, {
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
			const res = await fetch(`${url}/_hub/agents/agent-1/bind`, {
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
			await fetch(`${url}/_hub/agents/agent-1/bind`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c-1" }),
			});

			const unbind = await fetch(`${url}/_hub/agents/agent-1/unbind`, {
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
});
