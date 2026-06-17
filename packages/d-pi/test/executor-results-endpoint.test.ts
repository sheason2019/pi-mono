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

async function startHubWithAuth(workspaceRoot: string): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "results-test", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-results-test",
		description: "",
		publicKey: localUser.publicKey,
	});
	const executorRegistry = new ExecutorRegistry();
	const gateway = new HubGateway(
		new AgentRegistry(),
		new SourceManager(() => {}),
		async () => ({ agentName: "created" }),
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

describe("hub endpoint POST /_hub/executor/results", () => {
	beforeEach(() => {
		createTempDir("d-pi-exec-results-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("returns 200 for a result that matches a pending call, and resolves the pending response", async () => {
		const { url, executorRegistry, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			// Stage a fake pending response
			const calls: Array<{ status?: number; body?: string }> = [];
			const fakeRes = {
				writeHead: (status: number, _headers: Record<string, string>) => {
					calls.push({ status });
				},
				end: (body: string) => {
					calls[calls.length - 1]!.body = body;
				},
			} as never;
			executorRegistry.addPending("c1", "call-1", fakeRes);

			const res = await fetch(`${url}/_hub/executor/results`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", callId: "call-1", ok: true, result: { foo: 1 } }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });

			expect(calls).toHaveLength(1);
			expect(calls[0].status).toBe(200);
			expect(JSON.parse(calls[0].body!)).toEqual({ ok: true, result: { foo: 1 } });
			expect(executorRegistry.getPending("c1", "call-1")).toBeUndefined();
		} finally {
			await gateway.stop();
		}
	});

	it("returns 200 even when the callId has no pending response (drops the result)", async () => {
		const { url, executorRegistry, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			const res = await fetch(`${url}/_hub/executor/results`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", callId: "no-such-call", ok: true }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			await gateway.stop();
		}
	});

	it("propagates an error result to the pending response", async () => {
		const { url, executorRegistry, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });
			const calls: Array<{ status?: number; body?: string }> = [];
			const fakeRes = {
				writeHead: (status: number) => {
					calls.push({ status });
				},
				end: (body: string) => {
					calls[calls.length - 1]!.body = body;
				},
			} as never;
			executorRegistry.addPending("c1", "call-1", fakeRes);

			const res = await fetch(`${url}/_hub/executor/results`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", callId: "call-1", ok: false, error: "tool blew up" }),
			});
			expect(res.status).toBe(200);

			expect(calls).toHaveLength(1);
			expect(calls[0].status).toBe(200);
			expect(JSON.parse(calls[0].body!)).toEqual({ ok: false, error: "tool blew up" });
		} finally {
			await gateway.stop();
		}
	});

	it("returns 400 on missing fields", async () => {
		const { url, sessionToken, gateway } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/_hub/executor/results`, {
				method: "POST",
				headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1" }),
			});
			expect(res.status).toBe(400);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 401 without auth", async () => {
		const { url, gateway } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/_hub/executor/results`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ connectId: "c1", callId: "x", ok: true }),
			});
			expect(res.status).toBe(401);
		} finally {
			await gateway.stop();
		}
	});
});
