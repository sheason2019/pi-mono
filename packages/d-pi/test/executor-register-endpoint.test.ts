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
	localUserPublicKey: string;
}

async function startHubWithAuth(workspaceRoot: string): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "executor-test", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-executor-test",
		description: "",
		publicKey: localUser.publicKey,
	});
	const registry = new AgentRegistry();
	const executorRegistry = new ExecutorRegistry();
	const gateway = new HubGateway(
		registry,
		async () => ({ agentName: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
		executorRegistry,
	);
	await gateway.start(0);

	const challengeResponse = await fetch(`${gateway.url()}/api/auth/challenge`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ publicKey: localUser.publicKey }),
	});
	const challenge = (await challengeResponse.json()) as { challengeId: string; challenge: string };
	const sessionResponse = await fetch(`${gateway.url()}/api/auth/session`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			publicKey: localUser.publicKey,
			challengeId: challenge.challengeId,
			signature: signChallenge(localUser, challenge.challenge),
		}),
	});
	const session = (await sessionResponse.json()) as { token: string };

	return {
		url: gateway.url(),
		gateway,
		executorRegistry,
		sessionToken: session.token,
		localUserPublicKey: localUser.publicKey,
	};
}

describe("hub endpoint POST /api/executor/register", () => {
	beforeEach(() => {
		createTempDir("d-pi-exec-register-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("registers a new executor with cwd under a valid token", async () => {
		const { url, executorRegistry, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/api/executor/register`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", cwd: "/tmp" }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect(executorRegistry.get("c1")).toBeDefined();
			expect(executorRegistry.get("c1")!.cwd).toBe("/tmp");
			expect(executorRegistry.get("c1")!.attached).toBe(false);
		} finally {
			await gateway.stop();
		}
	});

	it("rejects duplicate registration of the same connectId with 409", async () => {
		const { url, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			const first = await fetch(`${url}/api/executor/register`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", cwd: "/tmp" }),
			});
			expect(first.status).toBe(200);
			const second = await fetch(`${url}/api/executor/register`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", cwd: "/other" }),
			});
			expect(second.status).toBe(409);
			expect(await second.json()).toMatchObject({ error: expect.stringMatching(/already registered/i) });
		} finally {
			await gateway.stop();
		}
	});

	it("rejects requests without an auth token with 401", async () => {
		const { url, gateway } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/api/executor/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", cwd: "/tmp" }),
			});
			expect(res.status).toBe(401);
		} finally {
			await gateway.stop();
		}
	});

	it("rejects body missing connectId or cwd with 400", async () => {
		const { url, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			const noCwd = await fetch(`${url}/api/executor/register`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1" }),
			});
			expect(noCwd.status).toBe(400);
			const noId = await fetch(`${url}/api/executor/register`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: "/tmp" }),
			});
			expect(noId.status).toBe(400);
		} finally {
			await gateway.stop();
		}
	});
});
