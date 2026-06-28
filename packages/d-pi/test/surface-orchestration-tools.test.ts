import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HubChannel } from "../src/multi-agent/hub-channel.ts";
import { setBuiltinContext } from "../src/surface/builtin-context.ts";
import { createHubActionsClientFromHubChannel } from "../src/surface/hub-actions-adapter.ts";
import type {
	DPiCreateAgentActionPayload,
	DPiCreateAgentActionResult,
	DPiDestroyAgentActionPayload,
	DPiHubActionsClient,
	DPiReloadWorkspaceResult,
	DPiSendMessageActionPayload,
	DPiTeamSnapshot,
} from "../src/surface/index.ts";
import { createDestroyAgentTool, createSendMessageTool, createTeamTool } from "../src/surface/orchestration-tools.ts";

interface TextToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

class RecordingHubActionsClient implements DPiHubActionsClient {
	readonly createAgentCalls: DPiCreateAgentActionPayload[] = [];
	readonly destroyAgentCalls: DPiDestroyAgentActionPayload[] = [];
	readonly sendMessageCalls: DPiSendMessageActionPayload[] = [];

	createAgentResult: DPiCreateAgentActionResult = { agentName: "child" };
	teamSnapshot: DPiTeamSnapshot = { rootName: "root", agents: [], sources: [], executors: [] };

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

	async dispatchRemoteTool(): Promise<never> {
		throw new Error("dispatchRemoteTool should not be used by orchestration tools");
	}

	async reloadWorkspace(): Promise<DPiReloadWorkspaceResult> {
		return { models: [], contextFiles: [], sources: { added: [], removed: [], changed: [], total: 0 } };
	}
}

function setupContext(client: RecordingHubActionsClient, agentName = "root"): void {
	setBuiltinContext({
		hubClient: client,
		agentName,
		localExecutors: {},
		remoteExecutor: {
			async executeRemoteTool(): Promise<never> {
				throw new Error("not implemented");
			},
		},
		getReloadFn: () => undefined,
		getReloadDetails: () => ({}),
		updatePlan: () => {},
		getPlan: () => [],
	});
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

		expect(source).not.toContain("HubChannel");
		expect(source).not.toContain("ExtensionAPI");
	});

	it("sends messages through the typed sendMessage action", async () => {
		const client = new RecordingHubActionsClient();
		setupContext(client, "root");
		const tool = createSendMessageTool();

		const result = asTextToolResult(
			await tool.execute("call-1", { agent_name: "child", message: "hello", mode: "steer" }),
		);

		expect(client.sendMessageCalls).toEqual([
			{ fromAgentName: "root", toAgentName: "child", content: "hello", mode: "steer" },
		]);
		expect(textOf(result)).toContain("Message sent to agent child (mode=steer)");
		expect(result.isError).toBeUndefined();
	});

	it("defaults to next mode when mode is not specified", async () => {
		const client = new RecordingHubActionsClient();
		setupContext(client, "root");
		const tool = createSendMessageTool();

		const result = asTextToolResult(await tool.execute("call-1", { agent_name: "child", message: "hello" }));

		expect(client.sendMessageCalls).toEqual([
			{ fromAgentName: "root", toAgentName: "child", content: "hello", mode: "next" },
		]);
		expect(textOf(result)).toContain("Message sent to agent child (mode=next)");
		expect(result.isError).toBeUndefined();
	});

	it("formats team snapshots with agent trees and executor details", async () => {
		const client = new RecordingHubActionsClient();
		client.teamSnapshot = {
			rootName: "root",
			agents: [
				{ name: "root", parentName: undefined, status: "ready", children: ["child"], cwd: "/fake" },
				{ name: "child", parentName: "root", status: "busy", children: ["grandchild"], cwd: "/fake" },
				{ name: "grandchild", parentName: "child", status: "starting", children: [], cwd: "/fake" },
			],
			sources: [],
			executors: [
				{ connectId: "exec-1", cwd: "/repo", attached: true, boundAgentName: "child" },
				{ connectId: "exec-2", cwd: "/tmp", attached: false, boundAgentName: undefined },
			],
		};
		setupContext(client);
		const tool = createTeamTool();

		const result = asTextToolResult(await tool.execute("call-3", {}));

		expect(textOf(result)).toContain("root [ready]");
		expect(textOf(result)).toContain("  -> child [busy]");
		expect(textOf(result)).toContain("    -> grandchild [starting]");
		expect(textOf(result)).toContain("exec-1 [attached] cwd=/repo bound to: child");
		expect(textOf(result)).toContain("exec-2 [registered] cwd=/tmp unbound");
		expectNoUndefined(result.details);
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
		expect(result.details).toEqual({
			agents: client.teamSnapshot.agents,
			sources: [],
			executors: client.teamSnapshot.executors,
		});
	});

	it("routes destroy_agent through the typed destroyAgent action", async () => {
		const client = new RecordingHubActionsClient();
		setupContext(client);
		const tool = createDestroyAgentTool();

		const result = asTextToolResult(await tool.execute("call-7", { agent_name: "child" }));

		expect(client.destroyAgentCalls).toEqual([{ agentName: "child" }]);
		expect(textOf(result)).toContain('Agent "child" destroyed');
	});

	it("marks ok false action results without errors as tool errors", async () => {
		const client = new RecordingHubActionsClient();
		client.sendMessage = async (payload: DPiSendMessageActionPayload): Promise<{ ok: boolean; error?: string }> => {
			client.sendMessageCalls.push(payload);
			return { ok: false };
		};
		setupContext(client, "root");
		const tool = createSendMessageTool();

		const result = asTextToolResult(
			await tool.execute("call-8", { agent_name: "child", message: "hello", mode: "next" }),
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
			createAgent: async (name: string, cwd?: string): Promise<{ agentName: string }> => {
				createAgentCalls.push({ name, cwd });
				return { agentName: name };
			},
		} as unknown as HubChannel;

		const client = createHubActionsClientFromHubChannel(channel);
		const result = await client.createAgent({
			name: "child",
			cwd: "/repo",
		});

		expect(createAgentCalls).toEqual([
			{
				name: "child",
				cwd: "/repo",
			},
		]);
		expect(result).toEqual({ agentName: "child" });
	});
});
