import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCreateAgentTool as createExtensionCreateAgentTool } from "../src/extension/create-agent.ts";
import { createHubActionsClientFromHubChannel } from "../src/extension/hub-actions-adapter.ts";
import type { HubChannel } from "../src/extension/hub-channel.ts";
import { createSendMessageTool as createExtensionSendMessageTool } from "../src/extension/send-message.ts";
import type {
	DPiCreateAgentActionPayload,
	DPiCreateAgentActionResult,
	DPiDeleteSourceActionPayload,
	DPiDestroyAgentActionPayload,
	DPiGetSourceActionPayload,
	DPiGetSourceActionResult,
	DPiHubActionsClient,
	DPiHubMessageMode,
	DPiSendMessageActionPayload,
	DPiSourceConfig,
	DPiTeamSnapshot,
} from "../src/surface/index.ts";
import {
	createDPiCreateAgentTool,
	createDPiDeleteSourceTool,
	createDPiDestroyAgentTool,
	createDPiGetSourceTool,
	createDPiSendMessageTool,
	createDPiSetSourceTool,
	createDPiTeamTool,
} from "../src/surface/orchestration-tools.ts";

interface TextToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

class RecordingHubActionsClient implements DPiHubActionsClient {
	readonly createAgentCalls: DPiCreateAgentActionPayload[] = [];
	readonly destroyAgentCalls: DPiDestroyAgentActionPayload[] = [];
	readonly sendMessageCalls: DPiSendMessageActionPayload[] = [];
	readonly setSourceCalls: DPiSourceConfig[] = [];
	readonly getSourceCalls: DPiGetSourceActionPayload[] = [];
	readonly deleteSourceCalls: DPiDeleteSourceActionPayload[] = [];

	createAgentResult: DPiCreateAgentActionResult = { agentName: "child" };
	teamSnapshot: DPiTeamSnapshot = { rootName: "root", agents: [], executors: [] };
	getSourceResult: DPiGetSourceActionResult = { sources: [] };

	async createAgent(payload: DPiCreateAgentActionPayload): Promise<DPiCreateAgentActionResult> {
		this.createAgentCalls.push(payload);
		return this.createAgentResult;
	}

	async destroyAgent(payload: DPiDestroyAgentActionPayload): Promise<{ ok: boolean; error?: string }> {
		this.destroyAgentCalls.push(payload);
		return { ok: true };
	}

	async getTeam(): Promise<DPiTeamSnapshot> {
		return this.teamSnapshot;
	}

	async sendMessage(payload: DPiSendMessageActionPayload): Promise<{ ok: boolean; error?: string }> {
		this.sendMessageCalls.push(payload);
		return { ok: true };
	}

	async setSource(payload: DPiSourceConfig): Promise<{ ok: boolean; error?: string }> {
		this.setSourceCalls.push(payload);
		return { ok: true };
	}

	async getSource(payload: DPiGetSourceActionPayload = {}): Promise<DPiGetSourceActionResult> {
		this.getSourceCalls.push(payload);
		return this.getSourceResult;
	}

	async deleteSource(payload: DPiDeleteSourceActionPayload): Promise<{ ok: boolean; error?: string }> {
		this.deleteSourceCalls.push(payload);
		return { ok: true };
	}

	async dispatchRemoteTool(): Promise<never> {
		throw new Error("dispatchRemoteTool should not be used by orchestration tools");
	}
}

function asTextToolResult(result: unknown): TextToolResult {
	return result as TextToolResult;
}

function textOf(result: TextToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

function expectNoUndefined(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			expectNoUndefined(item);
		}
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const field of Object.values(value)) {
			expect(field).not.toBeUndefined();
			expectNoUndefined(field);
		}
	}
}

describe("d-pi surface orchestration tools", () => {
	it("keeps surface orchestration tools independent from extension runtime APIs", async () => {
		const sourcePath = fileURLToPath(new URL("../src/surface/orchestration-tools.ts", import.meta.url));
		const source = await readFile(sourcePath, "utf8");

		expect(source).not.toContain("defineTool");
		expect(source).not.toContain("HubChannel");
		expect(source).not.toContain("ExtensionAPI");
	});

	it("sends messages through the typed sendMessage action", async () => {
		const client = new RecordingHubActionsClient();
		const tool = createDPiSendMessageTool(client, { agentName: "root" });

		const result = asTextToolResult(
			await tool.execute("call-1", { agent_id: "child", message: "hello", mode: "steer" }),
		);

		expect(client.sendMessageCalls).toEqual([
			{ fromAgentName: "root", toAgentName: "child", content: "hello", mode: "steer" },
		]);
		expect(textOf(result)).toContain("Message sent to agent child (mode=steer)");
		expect(result.isError).toBeUndefined();
	});

	it("rejects create_agent when includeTools and excludeTools are both provided", async () => {
		const client = new RecordingHubActionsClient();
		const tool = createDPiCreateAgentTool(client);

		const result = asTextToolResult(
			await tool.execute("call-2", {
				name: "child",
				includeTools: ["read"],
				excludeTools: ["bash"],
			}),
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/mutually exclusive/i);
		expect(client.createAgentCalls).toEqual([]);
	});

	it("formats team snapshots with agent trees and executor details", async () => {
		const client = new RecordingHubActionsClient();
		client.teamSnapshot = {
			rootName: "root",
			agents: [
				{ name: "root", parentName: undefined, status: "ready", model: "model-a", children: ["child"] },
				{ name: "child", parentName: "root", status: "busy", model: undefined, children: ["grandchild"] },
				{ name: "grandchild", parentName: "child", status: "starting", model: undefined, children: [] },
			],
			executors: [
				{ connectId: "exec-1", cwd: "/repo", attached: true, boundAgentName: "child" },
				{ connectId: "exec-2", cwd: "/tmp", attached: false, boundAgentName: undefined },
			],
		};
		const tool = createDPiTeamTool(client);

		const result = asTextToolResult(await tool.execute("call-3", {}));

		expect(textOf(result)).toContain("root [ready] -> [child]");
		expect(textOf(result)).toContain("  child [busy] -> [grandchild]");
		expect(textOf(result)).toContain("    grandchild [starting]");
		expect(textOf(result)).toContain("exec-1 [attached] cwd=/repo bound=child");
		expect(textOf(result)).toContain("exec-2 [registered] cwd=/tmp bound=(none)");
		expectNoUndefined(result.details);
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
		expect(result.details).toEqual({
			agents: [
				{ name: "root", status: "ready", model: "model-a", children: ["child"] },
				{ name: "child", parentName: "root", status: "busy", children: ["grandchild"] },
				{ name: "grandchild", parentName: "child", status: "starting", children: [] },
			],
			executors: [
				{ connectId: "exec-1", cwd: "/repo", attached: true, boundAgentName: "child" },
				{ connectId: "exec-2", cwd: "/tmp", attached: false },
			],
		});
	});

	it("routes source tools through setSource, getSource, and deleteSource actions", async () => {
		const client = new RecordingHubActionsClient();
		client.getSourceResult = {
			source: {
				name: "events",
				command: "node",
				args: ["server.js"],
				status: "running",
				subscribers: ["root"],
				cwd: undefined,
				env: undefined,
			},
		};

		const setTool = createDPiSetSourceTool(client);
		const getTool = createDPiGetSourceTool(client);
		const deleteTool = createDPiDeleteSourceTool(client);

		await setTool.execute("call-4", {
			name: "events",
			command: "node",
			args: ["server.js"],
			cwd: "/repo",
			env: { NODE_ENV: "test" },
			subscribers: ["root"],
		});
		const getResult = asTextToolResult(await getTool.execute("call-5", { name: "events" }));
		await deleteTool.execute("call-6", { name: "events" });

		expect(client.setSourceCalls).toEqual([
			{
				name: "events",
				command: "node",
				args: ["server.js"],
				cwd: "/repo",
				env: { NODE_ENV: "test" },
				subscribers: ["root"],
			},
		]);
		expect(client.getSourceCalls).toEqual([{ name: "events" }]);
		expect(client.deleteSourceCalls).toEqual([{ name: "events" }]);
		expect(textOf(getResult)).toContain('"name": "events"');
		expectNoUndefined(getResult.details);
		expect(JSON.parse(JSON.stringify(getResult.details))).toEqual(getResult.details);
		expect(getResult.details).toEqual({
			source: {
				name: "events",
				command: "node",
				args: ["server.js"],
				status: "running",
				subscribers: ["root"],
			},
		});
	});

	it("routes destroy_agent through the typed destroyAgent action", async () => {
		const client = new RecordingHubActionsClient();
		const tool = createDPiDestroyAgentTool(client);

		const result = asTextToolResult(await tool.execute("call-7", { agent_id: "child" }));

		expect(client.destroyAgentCalls).toEqual([{ agentName: "child" }]);
		expect(textOf(result)).toContain('Agent "child" destroyed');
	});

	it("marks ok false action results without errors as tool errors", async () => {
		const client = new RecordingHubActionsClient();
		client.sendMessage = async (payload: DPiSendMessageActionPayload): Promise<{ ok: boolean; error?: string }> => {
			client.sendMessageCalls.push(payload);
			return { ok: false };
		};
		const tool = createDPiSendMessageTool(client, { agentName: "root" });

		const result = asTextToolResult(
			await tool.execute("call-8", { agent_id: "child", message: "hello", mode: "next" }),
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Failed to send message");
	});
});

describe("orchestration tool adapters", () => {
	it("maps HubChannel createAgent results to the surface createAgent action shape", async () => {
		const createAgentCalls: DPiCreateAgentActionPayload[] = [];
		const channel = {
			agentName: "root",
			createAgent: async (
				name: string,
				cwd?: string,
				model?: string,
				roles?: string[],
				includeTools?: string[],
				excludeTools?: string[],
			): Promise<{ agentId: string; name: string }> => {
				createAgentCalls.push({ name, cwd, model, roles, includeTools, excludeTools });
				return { agentId: "agent-1", name };
			},
		} as unknown as HubChannel;

		const client = createHubActionsClientFromHubChannel(channel);
		const result = await client.createAgent({
			name: "child",
			cwd: "/repo",
			model: "model-a",
			roles: ["reviewer"],
			includeTools: ["read"],
		});

		expect(createAgentCalls).toEqual([
			{
				name: "child",
				cwd: "/repo",
				model: "model-a",
				roles: ["reviewer"],
				includeTools: ["read"],
				excludeTools: undefined,
			},
		]);
		expect(result).toEqual({ agentName: "child", agentId: "agent-1" });
	});

	it("keeps create_agent wrapper result text and details compatible with agentId", async () => {
		const channel = {
			agentName: "root",
			createAgent: async (name: string): Promise<{ agentId: string; name: string }> => ({
				agentId: "agent-1",
				name,
			}),
		} as unknown as HubChannel;
		const tool = createExtensionCreateAgentTool(channel);

		const result = asTextToolResult(await tool.execute("call-9", { name: "child" }));

		expect(textOf(result)).toContain('Created agent "child"');
		expect(textOf(result)).toContain("agent-1");
		expect(result.details).toEqual({ agentName: "child", agentId: "agent-1" });
	});

	it("keeps the send_message wrapper behavior aligned with the surface tool", async () => {
		const sendMessageCalls: Array<{ toAgentName: string; content: string; mode?: DPiHubMessageMode }> = [];
		const channel = {
			agentName: "root",
			sendMessage: async (
				toAgentName: string,
				content: string,
				mode?: DPiHubMessageMode,
			): Promise<{ ok: boolean }> => {
				sendMessageCalls.push({ toAgentName, content, mode });
				return { ok: true };
			},
		} as unknown as HubChannel;
		const tool = createExtensionSendMessageTool(channel);

		const result = asTextToolResult(
			await tool.execute("call-8", { agent_id: "child", message: "hello", mode: "next" }),
		);

		expect(sendMessageCalls).toEqual([{ toAgentName: "child", content: "hello", mode: "next" }]);
		expect(textOf(result)).toContain("Message sent to agent child (mode=next)");
		expect(result.isError).toBeUndefined();
	});

	it("keeps concrete extension tool files free of defineTool imports after migration", async () => {
		const names = [
			"send-message.ts",
			"create-agent.ts",
			"destroy-agent.ts",
			"team.ts",
			"set-source.ts",
			"get-source.ts",
			"delete-source.ts",
		];

		for (const name of names) {
			const sourcePath = fileURLToPath(new URL(`../src/extension/${name}`, import.meta.url));
			const source = await readFile(sourcePath, "utf8");

			expect(source).not.toContain("defineTool({");
		}
	});
});
