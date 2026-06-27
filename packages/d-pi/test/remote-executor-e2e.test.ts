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
	port: string;
}

async function startHub(workspaceRoot: string): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "e2e-test", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-e2e-test",
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
	const url = gateway.url();
	const port = new URL(url).port;
	const ch = (await (
		await fetch(`${url}/_hub/auth/challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicKey: localUser.publicKey }),
		})
	).json()) as { challengeId: string; challenge: string };
	const session = (await (
		await fetch(`${url}/_hub/auth/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				publicKey: localUser.publicKey,
				challengeId: ch.challengeId,
				signature: signChallenge(localUser, ch.challenge),
			}),
		})
	).json()) as { token: string };
	return { url, gateway, executorRegistry, sessionToken: session.token, port };
}

/**
 * Minimal HTTP caller that mimics what the (now-removed)
 * `createRemoteToolsExtension`'s `execute` did: POST to
 * `/agents/{name}/remote-call` with a callId / tool / params, await
 * the JSON body, and throw if the executor reported an error.
 *
 * The test uses this instead of the LLM-facing `remote_*` tool wrappers
 * because the wrappers live on the worker side (and dispatch via IPC);
 * this test exercises the HTTP path of the hub gateway directly.
 */
async function callRemoteViaHttp(
	hubUrl: string,
	authToken: string,
	agentId: string,
	tool: string,
	params: unknown,
): Promise<unknown> {
	const callId = crypto.randomUUID();
	const res = await fetch(`${hubUrl}/agents/${agentId}/remote-call`, {
		method: "POST",
		headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ callId, tool, params }),
	});
	if (!res.ok) {
		throw new Error(`Hub returned ${res.status}: ${await res.text()}`);
	}
	const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
	if (!body.ok) {
		throw new Error(body.error ?? "Unknown hub error");
	}
	return body.result;
}

describe("end-to-end remote executor round trip (HTTP path)", () => {
	beforeEach(() => {
		createTempDir("d-pi-e2e-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("remote_bash round-trips: HTTP POST -> hub -> executor SSE -> result back", async () => {
		const { url, gateway, executorRegistry, sessionToken, port } = await startHub(tempDir!);
		try {
			const callsReceived: Array<{ tool: string; params: unknown }> = [];
			executorRegistry.preRegister("agent-1", { cwd: "/tmp" });
			executorRegistry.attachSse("agent-1", {
				send: (event, data) => {
					if (event !== "remote-call") return;
					const payload = data as { callId: string; tool: string; params: unknown };
					callsReceived.push({ tool: payload.tool, params: payload.params });
					void fetch(`http://127.0.0.1:${port}/_hub/executor/results`, {
						method: "POST",
						headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
						body: JSON.stringify({
							connectId: "agent-1",
							callId: payload.callId,
							ok: true,
							result: {
								stdout: `[stub] ${(payload.params as { command?: string }).command ?? ""}`,
								exitCode: 0,
							},
						}),
					});
				},
			});
			gateway.bindAgent("agent-1", "agent-1");

			const result = await callRemoteViaHttp(url, sessionToken, "agent-1", "bash", { command: "echo hello" });
			expect(result).toEqual({ stdout: "[stub] echo hello", exitCode: 0 });
			expect(callsReceived).toEqual([{ tool: "bash", params: { command: "echo hello" } }]);
		} finally {
			await gateway.stop();
		}
	});

	it("propagates executor errors back to the HTTP caller", async () => {
		const { url, gateway, executorRegistry, sessionToken, port } = await startHub(tempDir!);
		try {
			executorRegistry.preRegister("agent-2", { cwd: "/tmp" });
			executorRegistry.attachSse("agent-2", {
				send: (_event, data) => {
					const payload = data as { callId: string };
					void fetch(`http://127.0.0.1:${port}/_hub/executor/results`, {
						method: "POST",
						headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
						body: JSON.stringify({
							connectId: "agent-2",
							callId: payload.callId,
							ok: false,
							error: "permission denied",
						}),
					});
				},
			});
			gateway.bindAgent("agent-2", "agent-2");

			await expect(callRemoteViaHttp(url, sessionToken, "agent-2", "bash", { command: "rm -rf /" })).rejects.toThrow(
				/permission denied/,
			);
		} finally {
			await gateway.stop();
		}
	});
});
