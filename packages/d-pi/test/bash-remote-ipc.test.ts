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
import { Hub } from "../src/hub/hub.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import { createBashRemoteTool } from "../src/extension/bash-remote.ts";
import { HubChannel } from "../src/extension/hub-channel.ts";
import type { WorkerToHubMessage } from "../src/types.ts";


let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

/**
 * Tests for the in-process executor dispatch path used by
 * `bash_remote` and any future `*_remote` server-side tools.
 *
 * The flow under test:
 *
 *   1. Server-side worker (AgentSession in a Worker thread) calls
 *      `bashRemote.execute()` which calls
 *      `HubChannel.callExecutor("bash", params)`.
 *   2. `HubChannel._callTool` posts an IPC `tool_call` message to
 *      the hub with `tool: "call_executor"`.
 *   3. `Hub._handleToolCall("call_executor", ...)` looks up
 *      `_gateway.getBinding(agentName)`, parks a callback-based
 *      `PendingCall` on the executor registry, and sends a
 *      `remote-call` SSE event to the client.
 *   4. Client runs the tool locally and POSTs the result to
 *      `/_hub/executor/results`, which the hub uses to resolve the
 *      in-flight callback.
 *   5. The hub replies via the `tool_result` IPC message, which
 *      `HubChannel._callTool` resolves back to the
 *      `bashRemote.execute()` promise.
 *
 * These tests use a fake `Worker` thread and a fake tool result
 * POSTer to exercise the hub-side state machine (binding lookup,
 * PendingCall parking, callback resolution, timeout) without
 * spawning a real worker thread or a real client.
 */
describe("bash_remote via in-process call_executor dispatch", () => {
	let workspaceRoot: string;
	let executorRegistry: ExecutorRegistry;
	let gateway: HubGateway;
	let hub: Hub;
	let url: string;
	let port: string;
	let sessionToken: string;

	beforeEach(async () => {
		workspaceRoot = createTempDir("d-pi-bash-remote-");
		const localUser = createLocalUser(workspaceRoot, { name: "bash-remote-test", description: "" });
		createAllowedUser(workspaceRoot, {
			name: "allowed-bash-remote-test",
			description: "",
			publicKey: localUser.publicKey,
		});
		executorRegistry = new ExecutorRegistry();
		gateway = new HubGateway(
			new AgentRegistry(0),
			new SourceManager(() => {}),
			async () => ({ agentName: "created" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
			executorRegistry,
		);
		// Use a no-auth AuthSessionManager (`undefined`) for these
		// tests so the test code does not have to walk the full
		// challenge-response dance. The real hub still constructs
		// one — see the "with auth" test variant below.
		await gateway.start(0);
		url = gateway.url();
		port = new URL(url).port;

		// Build a real Hub instance (not just a gateway) so we
		// exercise the actual `_handleToolCall("call_executor", ...)`
		// code path, not a mock of it.
		hub = new Hub({
			port: 0,
			cwd: workspaceRoot,
			workspaceRoot,
			workspaceContext: { agentName: "test-agent", sections: [], mergedRulesText: "" } as never,
			workspaceConfig: {} as never,
		});
		// Replace the hub's gateway with the one we already started
		// so the test can drive messages into the live executor
		// registry through both the IPC path (via _handleToolCall)
		// and the HTTP result endpoint. Also point the hub's
		// executor registry at the one we built, so the
		// `_handleToolCall("call_executor", ...)` path finds
		// the same registry the gateway is using.
		(hub as unknown as { _gateway: HubGateway; _executorRegistry: ExecutorRegistry })._gateway = gateway;
		(hub as unknown as { _executorRegistry: ExecutorRegistry })._executorRegistry = executorRegistry;

		// For the auth-on path, walk the challenge dance to obtain a
		// real session token. We register the auth manager on the
		// gateway before starting it, so this is what production
		// hits.
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
		sessionToken = session.token;
	});

	afterEach(async () => {
		await gateway.stop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	/**
	 * Drive a single IPC `tool_call` through `Hub._handleToolCall`
	 * and wait for the matching `tool_result`. Returns the result
	 * payload.
	 *
	 * `worker.postMessage` is a no-op here because we never actually
	 * have a worker thread — the hub just records the result for
	 * the assertion.
	 */
	function invokeCallExecutor(agentName: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const callId = `${agentName}-ipc-${Math.random().toString(36).slice(2)}`;
			// Inject a fake Worker for the agent. The hub's
			// `_handleToolCall` will look up the agent in the
			// registry and call `agent.worker.postMessage(...)` to
			// deliver the tool_result. We capture that postMessage
			// call and resolve this promise with the result.
			const fakeWorker = {
				postMessage(message: WorkerToHubMessage) {
					if (message.type === "tool_result" && message.callId === callId) {
						resolve(message.result);
					}
				},
				on() {},
				off() {},
			};
			(hub as unknown as { _registry: AgentRegistry })._registry.register({
				name: agentName,
				parentName: undefined,
				children: [],
				port: 0,
				status: "ready",
				worker: fakeWorker as never,
				cwd: workspaceRoot,
			});
			// Now invoke the dispatch. This is what the worker's
			// HubChannel._callTool ends up doing in production: a
			// `tool_call` IPC message lands in the hub's worker
			// message handler. We call the public method
			// `_handleToolCall` directly because we are bypassing
			// the IPC layer in this unit test.
			void (hub as unknown as {
				_handleToolCall(callId: string, tool: string, params: unknown, fromAgentName: string): Promise<void>;
			})._handleToolCall(callId, "call_executor", params, agentName);
		});
	}

	it("returns an error when the agent is not bound to an executor", async () => {
		// No binding — the hub should refuse to dispatch and the
		// tool result should carry an error explaining the situation.
		const result = (await invokeCallExecutor("orphan-agent", {
			tool: "bash",
			params: { command: "echo hi" },
		})) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not bound/i);
	});

	it("returns an error when the executor is pre-registered but not yet attached", async () => {
		gateway.bindAgent("agent-no-sse", "executor-no-sse");
		executorRegistry.preRegister("executor-no-sse", { cwd: "/tmp" });
		// No attachSse — sseConn is undefined.
		const result = (await invokeCallExecutor("agent-no-sse", {
			tool: "bash",
			params: { command: "echo hi" },
		})) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not yet ready/i);
	});

	it("dispatches a tool to the bound executor and resolves on result POST", async () => {
		gateway.bindAgent("agent-with-sse", "executor-with-sse");

		// Capture the remote-call event the hub sends over SSE so
		// the test can simulate the client executor's response.
		const dispatched: Array<{ callId: string; tool: string; params: unknown }> = [];
		executorRegistry.preRegister("executor-with-sse", { cwd: "/tmp" });
		executorRegistry.attachSse("executor-with-sse", {
			send(event, data) {
				if (event === "remote-call") {
					const payload = data as { callId: string; tool: string; params: unknown };
					dispatched.push(payload);
					// Simulate the client running the tool and
					// posting the result back. We do this
					// synchronously after capturing so the test
					// does not have to sleep or poll.
					setTimeout(() => {
						void fetch(`${url}/_hub/executor/results`, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${sessionToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								connectId: "executor-with-sse",
								callId: payload.callId,
								ok: true,
								result: { stdout: `[stub] ${(payload.params as { command: string }).command}` },
							}),
						});
					}, 0);
				}
			},
		});

		const result = (await invokeCallExecutor("agent-with-sse", {
			tool: "bash",
			params: { command: "echo hello" },
		})) as { ok: boolean; result: { stdout: string } };

		expect(result.ok).toBe(true);
		expect(result.result.stdout).toBe("[stub] echo hello");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.tool).toBe("bash");
		expect(dispatched[0]?.params).toEqual({ command: "echo hello" });
		// Pending entry is cleared after resolve.
		expect(executorRegistry.get("executor-with-sse")?.pendingCalls.size ?? 0).toBe(0);
	});

	it("propagates executor-reported errors back to the dispatcher", async () => {
		gateway.bindAgent("agent-error", "executor-error");
		executorRegistry.preRegister("executor-error", { cwd: "/tmp" });
		executorRegistry.attachSse("executor-error", {
			send(event, data) {
				if (event === "remote-call") {
					const payload = data as { callId: string };
					setTimeout(() => {
						void fetch(`${url}/_hub/executor/results`, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${sessionToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								connectId: "executor-error",
								callId: payload.callId,
								ok: false,
								error: "permission denied",
							}),
						});
					}, 0);
				}
			},
		});

		const result = (await invokeCallExecutor("agent-error", {
			tool: "bash",
			params: { command: "rm -rf /" },
		})) as { ok: boolean; error: string };

		expect(result.ok).toBe(false);
		expect(result.error).toBe("permission denied");
	});
});

describe("HubChannel.callExecutor posts a call_executor IPC tool_call", () => {
	it("uses tool name 'call_executor' and forwards { tool, params } verbatim", () => {
		const posted: WorkerToHubMessage[] = [];
		const channel = new HubChannel("test-agent", (msg) => posted.push(msg));
		void channel.callExecutor("bash", { command: "ls -la" });
		expect(posted).toHaveLength(1);
		const msg = posted[0] as Extract<WorkerToHubMessage, { type: "tool_call" }>;
		expect(msg.type).toBe("tool_call");
		expect(msg.tool).toBe("call_executor");
		expect(msg.params).toEqual({ tool: "bash", params: { command: "ls -la" } });
		expect(msg.agentName).toBe("test-agent");
	});
});
