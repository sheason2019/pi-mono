import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHubActionsClientFromHubChannel } from "../src/extension/hub-actions-adapter.ts";
import { HubChannel } from "../src/extension/hub-channel.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { Hub } from "../src/hub/hub.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import { createDPiSendMessageTool } from "../src/surface/orchestration-tools.ts";
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
		});
		void (
			hub as unknown as {
				_handleToolCall(callId: string, tool: string, params: unknown, fromAgentName: string): Promise<void>;
			}
		)._handleToolCall(callId, "dispatch", params, agentName);
	});
}

function registerFakeAgent(
	hub: Hub,
	agentName: string,
	onPostMessage: (message: HubToWorkerMessage) => void,
	parentName?: string,
): void {
	(hub as unknown as { _registry: AgentRegistry })._registry.register({
		name: agentName,
		parentName,
		children: [],
		port: 0,
		status: "ready",
		worker: {
			postMessage: onPostMessage,
			on() {},
			off() {},
		} as never,
		cwd: tempDir!,
	});
}

describe('remote tool dispatch via IPC (case "dispatch" in _handleToolCall)', () => {
	let hub: Hub;
	let executorRegistry: ExecutorRegistry;
	let gateway: HubGateway;

	beforeEach(() => {
		createTempDir("d-pi-remote-ipc-");
		executorRegistry = new ExecutorRegistry();
		gateway = new HubGateway(
			new AgentRegistry(),
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
			connect_id: "test-conn",
		})) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/no d-pi client with connect_id/i);
	});

	it("returns an error when executor is pre-registered but not attached", async () => {
		gateway.bindAgent("agent-no-sse", "test-conn");
		executorRegistry.preRegister("test-conn", { cwd: "/tmp" });
		// No attachSse — sseConn is undefined.
		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-no-sse", {
			tool: "bash",
			params: { command: "echo hi" },
			connect_id: "test-conn",
		})) as { ok: boolean; error: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not yet ready/i);
	});

	it("dispatches via IPC to the bound executor and resolves on result", async () => {
		gateway.bindAgent("agent-ipc", "test-conn");
		executorRegistry.preRegister("test-conn", { cwd: "/tmp" });
		const dispatched: Array<{ callId: string; tool: string; params: unknown }> = [];
		executorRegistry.attachSse("test-conn", {
			send(event, data) {
				if (event !== "remote-call") return;
				const payload = data as { callId: string; tool: string; params: unknown };
				dispatched.push(payload);
				// Simulate the executor running the tool and calling
				// resolveOne to post the result back. In production this
				// goes through HTTP POST /_hub/executor/results, but for
				// this unit test we call the registry directly.
				setTimeout(() => {
					executorRegistry.resolveOne("test-conn", payload.callId, {
						ok: true,
						result: { stdout: `[stub] ${(payload.params as { command: string }).command}` },
					});
				}, 0);
			},
		});

		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-ipc", {
			tool: "bash",
			params: { command: "echo hello" },
			connect_id: "test-conn",
		})) as { ok: boolean; result: { stdout: string } };

		expect(result.ok).toBe(true);
		expect(result.result.stdout).toBe("[stub] echo hello");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.tool).toBe("bash");
		expect(dispatched[0]?.params).toEqual({ command: "echo hello" });
		// Pending entry is cleared after resolve.
		expect(executorRegistry.get("test-conn")?.pendingCalls.size ?? 0).toBe(0);
	});

	it("propagates executor-reported errors back to the IPC caller", async () => {
		gateway.bindAgent("agent-err", "test-conn");
		executorRegistry.preRegister("test-conn", { cwd: "/tmp" });
		executorRegistry.attachSse("test-conn", {
			send(event, data) {
				if (event !== "remote-call") return;
				const payload = data as { callId: string };
				setTimeout(() => {
					executorRegistry.resolveOne("test-conn", payload.callId, {
						ok: false,
						error: "permission denied",
					});
				}, 0);
			},
		});

		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-err", {
			tool: "bash",
			params: { command: "rm -rf /" },
			connect_id: "test-conn",
		})) as { ok: boolean; error: string };

		expect(result.ok).toBe(false);
		expect(result.error).toBe("permission denied");
	});

	it("returns an error when tool param is missing", async () => {
		gateway.bindAgent("agent-missing", "test-conn");
		executorRegistry.preRegister("test-conn", { cwd: "/tmp" });
		executorRegistry.attachSse("test-conn", { send: () => {} });

		const result = (await invokeRemoteViaIpc(hub, executorRegistry, gateway, "agent-missing", {
			// missing `tool` field but has connect_id
			tool: undefined,
			params: { command: "echo hi" },
			connect_id: "test-conn",
		})) as { ok: boolean; error: string };

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/tool is required/i);
	});
});

describe('send_message via IPC (case "send_message" in _handleToolCall)', () => {
	let hub: Hub;
	let executorRegistry: ExecutorRegistry;
	let gateway: HubGateway;

	beforeEach(() => {
		createTempDir("d-pi-send-message-ipc-");
		executorRegistry = new ExecutorRegistry();
		gateway = new HubGateway(
			new AgentRegistry(),
			new SourceManager(() => {}),
			async () => ({ agentName: "created" }),
			async () => {},
			undefined,
			executorRegistry,
		);
		hub = new Hub({
			port: 0,
			cwd: tempDir!,
			workspaceRoot: tempDir!,
			workspaceContext: { workspaceRoot: tempDir!, additionalSkillPaths: [], additionalExtensionPaths: [] },
			workspaceConfig: { version: 1 } as never,
		});
		(hub as unknown as { _gateway: HubGateway })._gateway = gateway;
		(hub as unknown as { _executorRegistry: ExecutorRegistry })._executorRegistry = executorRegistry;
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("routes the message to the named target agent worker and resolves the caller tool result", async () => {
		const rootResults: unknown[] = [];
		const childMessages: HubToWorkerMessage[] = [];
		const callId = "send-message-call-1";
		registerFakeAgent(hub, "root", (message) => {
			if (message.type === "tool_result" && message.callId === callId) {
				rootResults.push(message.result);
			}
		});
		registerFakeAgent(
			hub,
			"child",
			(message) => {
				childMessages.push(message);
			},
			"root",
		);

		await (
			hub as unknown as {
				_handleToolCall(callId: string, tool: string, params: unknown, fromAgentName: string): Promise<void>;
			}
		)._handleToolCall(callId, "send_message", { agent_id: "child", message: "hello child", mode: "steer" }, "root");

		expect(rootResults).toEqual([{ ok: true }]);
		expect(childMessages).toHaveLength(1);
		expect(childMessages[0]).toMatchObject({
			type: "message",
			fromAgentName: "root",
			mode: "steer",
		});
		const delivered = childMessages[0] as Extract<HubToWorkerMessage, { type: "message" }>;
		expect(delivered.content).toContain("hello child");
		expect(delivered.content).toContain('"sourceType":"agent"');
		expect(delivered.content).toContain('"agentName":"root"');
	});

	it("accepts legacy agentIds target params at the hub boundary", async () => {
		const rootResults: unknown[] = [];
		const childMessages: HubToWorkerMessage[] = [];
		const callId = "send-message-call-legacy-agent-ids";
		registerFakeAgent(hub, "root", (message) => {
			if (message.type === "tool_result" && message.callId === callId) {
				rootResults.push(message.result);
			}
		});
		registerFakeAgent(
			hub,
			"child",
			(message) => {
				childMessages.push(message);
			},
			"root",
		);

		await (
			hub as unknown as {
				_handleToolCall(callId: string, tool: string, params: unknown, fromAgentName: string): Promise<void>;
			}
		)._handleToolCall(callId, "send_message", { agentIds: ["child"], message: "hello child" }, "root");

		expect(rootResults).toEqual([{ ok: true }]);
		expect(childMessages).toHaveLength(1);
		expect(childMessages[0]).toMatchObject({
			type: "message",
			fromAgentName: "root",
			mode: "next",
		});
	});

	it("routes through the real send_message tool and HubChannel to the target worker", async () => {
		let channel: HubChannel | undefined;
		const childMessages: HubToWorkerMessage[] = [];
		registerFakeAgent(hub, "root", (message) => {
			if (message.type === "tool_result") {
				channel?.resolveCall(message.callId, message.result);
			}
		});
		registerFakeAgent(
			hub,
			"child",
			(message) => {
				childMessages.push(message);
			},
			"root",
		);
		channel = new HubChannel("root", (message) => {
			(
				hub as unknown as { _handleWorkerMessage(worker: unknown, message: WorkerToHubMessage): void }
			)._handleWorkerMessage({}, message);
		});
		const client = createHubActionsClientFromHubChannel(channel);
		const tool = createDPiSendMessageTool(client, { agentName: "root" });

		const result = await tool.execute("call-1", {
			agent_id: "child",
			message: "hello through tool",
			mode: "next",
		});

		expect((result as { isError?: boolean }).isError).toBeUndefined();
		expect(childMessages).toHaveLength(1);
		expect(childMessages[0]).toMatchObject({
			type: "message",
			fromAgentName: "root",
			mode: "next",
		});
		expect((childMessages[0] as Extract<HubToWorkerMessage, { type: "message" }>).content).toContain(
			"hello through tool",
		);
	});
});

describe("HubChannel.callDispatch posts a dispatch IPC tool_call", () => {
	it("uses tool name 'remote' and forwards { tool, params } verbatim", () => {
		const posted: WorkerToHubMessage[] = [];
		const channel = new HubChannel("test-agent", (msg) => posted.push(msg));
		void channel.callDispatch("bash", { command: "ls -la" }, "test-conn");
		expect(posted).toHaveLength(1);
		const msg = posted[0] as Extract<WorkerToHubMessage, { type: "tool_call" }>;
		expect(msg.type).toBe("tool_call");
		expect(msg.tool).toBe("dispatch");
		expect(msg.params).toEqual({ tool: "bash", params: { command: "ls -la" }, connect_id: "test-conn" });
		expect(msg.agentName).toBe("test-agent");
	});
});
