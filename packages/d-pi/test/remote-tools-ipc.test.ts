import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubChannel } from "../src/extension/hub-channel.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { Hub } from "../src/hub/hub.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import type { HubToWorkerMessage, WorkerToHubMessage } from "../src/types.ts";

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

/**
 * Drive a single IPC `tool_call` through `Hub._handleToolCall` and
 * wait for the matching `tool_result`. Returns the result payload.
 *
 * `worker.postMessage` is a fake: it captures the `tool_result`
 * message the hub posts back to the worker, which lets the test
 * assert on the resolved value.
 */
function invokeRemoteViaIpc(
	hub: Hub,
	_executorRegistry: ExecutorRegistry,
	_gateway: HubGateway,
	agentName: string,
	params: unknown,
): Promise<unknown> {
	return new Promise((resolve, _reject) => {
		const callId = `${agentName}-ipc-test-${Math.random().toString(36).slice(2)}`;
		const fakeWorker = {
			postMessage(message: HubToWorkerMessage) {
				if (message.type === "tool_result" && message.callId === callId) {
					resolve(message.result);
				}
			},
			on() {},
			off() {},
		};
		// Register a fake agent in the hub's registry so
		// _handleToolCall can find it and post the result back.
		(hub as unknown as { _registry: AgentRegistry })._registry.register({
			name: agentName,
			parentName: undefined,
			children: [],
			port: 0,
			status: "ready",
			worker: fakeWorker as never,
			cwd: tempDir!,
			model: undefined,
		});
		void (
			hub as unknown as {
				_handleToolCall(callId: string, tool: string, params: unknown, fromAgentName: string): Promise<void>;
			}
		)._handleToolCall(callId, "remote", params, agentName);
	});
}

describe('remote tool dispatch via IPC (case "remote" in _handleToolCall)', () => {
	let hub: Hub;
	let executorRegistry: ExecutorRegistry;
	let gateway: HubGateway;

	beforeEach(() => {
		createTempDir("d-pi-remote-ipc-");
		executorRegistry = new ExecutorRegistry();
		gateway = new HubGateway(
			new AgentRegistry(0),
			new SourceManager(() => {}),
			async () => ({ agentName: "created" }),
			async () => {},
			undefined, // no auth — internal IPC path doesn't need it
			executorRegistry,
		);
		hub = new Hub({
			port: 0,
			cwd: tempDir!,
			workspaceRoot: tempDir!,
			workspaceContext: { workspaceRoot: tempDir!, additionalSkillPaths: [], additionalExtensionPaths: [] },
			workspaceConfig: { version: 1 } as never,
		});
		// Replace the hub's internal references with our test instances
		// so _handleToolCall uses the same executorRegistry / gateway
		// we set up with SSE stubs.
		(hub as unknown as { _gateway: HubGateway })._gateway = gateway;
		(hub as unknown as { _executorRegistry: ExecutorRegistry })._executorRegistry = executorRegistry;
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("returns an error when the agent is not bound to an executor", async () => {
		// No binding — hub should refuse and return a clear error.
		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "orphan-agent", {
			tool: "bash",
			params: { command: "echo hi" },
		})) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not bound/i);
	});

	it("returns an error when executor is pre-registered but not attached", async () => {
		gateway.bindAgent("agent-no-sse", "executor-no-sse");
		executorRegistry.preRegister("executor-no-sse", { cwd: "/tmp" });
		// No attachSse — sseConn is undefined.
		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-no-sse", {
			tool: "bash",
			params: { command: "echo hi" },
		})) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not yet ready/i);
	});

	it("dispatches via IPC to the bound executor and resolves on result", async () => {
		gateway.bindAgent("agent-ipc", "executor-ipc");
		executorRegistry.preRegister("executor-ipc", { cwd: "/tmp" });
		const dispatched: Array<{ callId: string; tool: string; params: unknown }> = [];
		executorRegistry.attachSse("executor-ipc", {
			send(event, data) {
				if (event !== "remote-call") return;
				const payload = data as { callId: string; tool: string; params: unknown };
				dispatched.push(payload);
				// Simulate the executor running the tool and calling
				// resolveOne to post the result back. In production this
				// goes through HTTP POST /_hub/executor/results, but for
				// this unit test we call the registry directly.
				setTimeout(() => {
					executorRegistry.resolveOne("executor-ipc", payload.callId, {
						ok: true,
						result: { stdout: `[stub] ${(payload.params as { command: string }).command}` },
					});
				}, 0);
			},
		});

		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-ipc", {
			tool: "bash",
			params: { command: "echo hello" },
		})) as { ok: boolean; result: { stdout: string } };

		expect(result.ok).toBe(true);
		expect(result.result.stdout).toBe("[stub] echo hello");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.tool).toBe("bash");
		expect(dispatched[0]?.params).toEqual({ command: "echo hello" });
		// Pending entry is cleared after resolve.
		expect(executorRegistry.get("executor-ipc")?.pendingCalls.size ?? 0).toBe(0);
	});

	it("propagates executor-reported errors back to the IPC caller", async () => {
		gateway.bindAgent("agent-err", "executor-err");
		executorRegistry.preRegister("executor-err", { cwd: "/tmp" });
		executorRegistry.attachSse("executor-err", {
			send(event, data) {
				if (event !== "remote-call") return;
				const payload = data as { callId: string };
				setTimeout(() => {
					executorRegistry.resolveOne("executor-err", payload.callId, {
						ok: false,
						error: "permission denied",
					});
				}, 0);
			},
		});

		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-err", {
			tool: "bash",
			params: { command: "rm -rf /" },
		})) as { ok: boolean; error: string };

		expect(result.ok).toBe(false);
		expect(result.error).toBe("permission denied");
	});

	it("returns an error when tool param is missing", async () => {
		gateway.bindAgent("agent-missing", "executor-missing");
		executorRegistry.preRegister("executor-missing", { cwd: "/tmp" });
		executorRegistry.attachSse("executor-missing", { send: () => {} });

		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-missing", {
			// missing `tool` field
			params: { command: "echo hi" },
		})) as { ok: boolean; error: string };

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/tool is required/i);
	});
});

describe("HubChannel.callRemote posts a remote IPC tool_call", () => {
	it("uses tool name 'remote' and forwards { tool, params } verbatim", () => {
		const posted: WorkerToHubMessage[] = [];
		const channel = new HubChannel("test-agent", (msg) => posted.push(msg));
		void channel.callRemote("bash", { command: "ls -la" });
		expect(posted).toHaveLength(1);
		const msg = posted[0] as Extract<WorkerToHubMessage, { type: "tool_call" }>;
		expect(msg.type).toBe("tool_call");
		expect(msg.tool).toBe("remote");
		expect(msg.params).toEqual({ tool: "bash", params: { command: "ls -la" } });
		expect(msg.agentName).toBe("test-agent");
	});
});
