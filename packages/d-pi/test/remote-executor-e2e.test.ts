import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRemoteToolsExtension } from "../src/agent-extension/remote-tools.ts";
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
		new AgentRegistry(0),
		new SourceManager(() => {}),
		async () => ({ agentId: "created", name: "created" }),
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

interface ToolCapture {
	definitions: Map<string, ToolDefinition>;
	invoke: (name: string, params: unknown) => Promise<unknown>;
}

function captureTools(extensionOptions: Parameters<typeof createRemoteToolsExtension>[0]): ToolCapture {
	const definitions = new Map<string, ToolDefinition>();
	createRemoteToolsExtension({
		...extensionOptions,
		registerTool: (name, def) => {
			definitions.set(name, def);
		},
	});
	return {
		definitions,
		invoke: async (name, params) => {
			const def = definitions.get(name);
			if (!def) throw new Error(`Tool not registered: ${name}`);
			// Real pi signature: (toolCallId, params, signal, onUpdate, ctx).
			// Cast through unknown since the test has no real ExtensionContext.
			return (def.execute as unknown as (...a: unknown[]) => Promise<unknown>)(
				"test-call",
				params,
				undefined,
				undefined,
				undefined,
			);
		},
	};
}

describe("end-to-end remote executor round trip", () => {
	beforeEach(() => {
		createTempDir("d-pi-e2e-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("remote_bash round-trips: agent call -> hub -> executor -> result back", async () => {
		const { url, gateway, executorRegistry, sessionToken, port } = await startHub(tempDir!);
		try {
			// Simulate a registered executor that runs a real tool. We use a
			// stub ToolDefinition so the test doesn't depend on any specific
			// native tool's behavior.
			const callsReceived: Array<{ tool: string; params: unknown }> = [];
			const echoTool = {
				name: "bash",
				label: "stub bash",
				description: "stub",
				parameters: {},
				execute: async (_id: string, params: unknown) => {
					callsReceived.push({ tool: "bash", params });
					const p = params as { command?: string };
					return { stdout: `[stub] ${p.command ?? ""}`, exitCode: 0 };
				},
			} as unknown as ToolDefinition;
			executorRegistry.preRegister("agent-1", { cwd: "/tmp" });
			executorRegistry.attachSse("agent-1", {
				send: (event, data) => {
					if (event !== "remote-call") return;
					const payload = data as { callId: string; tool: string; params: unknown };
					// Look up the tool by name. In production this uses ToolRunner;
					// here we have a single stub that handles "bash" and rejects
					// anything else.
					const run = async () => {
						if (payload.tool === "bash") {
							try {
								const result = await (echoTool.execute as unknown as (...a: unknown[]) => Promise<unknown>)(
									payload.callId,
									payload.params,
									undefined,
									undefined,
									undefined,
								);
								void fetch(`http://127.0.0.1:${port}/_hub/executor/results`, {
									method: "POST",
									headers: {
										Authorization: `Bearer ${sessionToken}`,
										"Content-Type": "application/json",
									},
									body: JSON.stringify({
										connectId: "agent-1",
										callId: payload.callId,
										ok: true,
										result,
									}),
								});
							} catch (e) {
								void fetch(`http://127.0.0.1:${port}/_hub/executor/results`, {
									method: "POST",
									headers: {
										Authorization: `Bearer ${sessionToken}`,
										"Content-Type": "application/json",
									},
									body: JSON.stringify({
										connectId: "agent-1",
										callId: payload.callId,
										ok: false,
										error: e instanceof Error ? e.message : String(e),
									}),
								});
							}
						} else {
							void fetch(`http://127.0.0.1:${port}/_hub/executor/results`, {
								method: "POST",
								headers: {
									Authorization: `Bearer ${sessionToken}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									connectId: "agent-1",
									callId: payload.callId,
									ok: false,
									error: `Unknown tool: ${payload.tool}`,
								}),
							});
						}
					};
					void run();
				},
			});
			gateway.bindAgent("agent-1", "agent-1");

			const tools = captureTools({
				api: { DPI_HUB_URL: url, DPI_AUTH_TOKEN: sessionToken, agentId: "agent-1" },
				fetchImpl: fetch,
				registerTool: () => {},
			});

			const result = await tools.invoke("remote_bash", { command: "echo hello" });
			expect(result).toEqual({ stdout: "[stub] echo hello", exitCode: 0 });
			expect(callsReceived).toEqual([{ tool: "bash", params: { command: "echo hello" } }]);
		} finally {
			await gateway.stop();
		}
	});

	it("propagates executor errors back to the tool caller", async () => {
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

			const tools = captureTools({
				api: { DPI_HUB_URL: url, DPI_AUTH_TOKEN: sessionToken, agentId: "agent-2" },
				fetchImpl: fetch,
				registerTool: () => {},
			});

			await expect(tools.invoke("remote_bash", { command: "rm -rf /" })).rejects.toThrow(/permission denied/);
		} finally {
			await gateway.stop();
		}
	});
});
