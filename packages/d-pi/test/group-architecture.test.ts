import type { ExtensionAPI, ToolDefinition } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createGroupArchitectureTool } from "../src/extension/group-architecture.ts";
import { HubChannel } from "../src/extension/hub-channel.ts";
import { createDPiExtension } from "../src/extension/index.ts";
import type { GroupArchitectureSnapshot, WorkerToHubMessage } from "../src/types.ts";

/**
 * Build a real HubChannel whose outbound tool_call messages we can intercept
 * and resolve on the spot. This way we exercise the actual channel wiring
 * (call id, message type, payload shape) without needing a running hub.
 */
function makeChannel(): {
	channel: HubChannel;
	posted: WorkerToHubMessage[];
	respondToNext: (result: unknown) => void;
} {
	const posted: WorkerToHubMessage[] = [];
	let nextResponder: ((result: unknown) => void) | undefined;
	const channel = new HubChannel("agent-test", (msg) => {
		posted.push(msg);
		if (msg.type === "tool_call") {
			// Capture the callId so the test driver can resolve it from
			// outside. We keep the responder reference until the test calls
			// `respondToNext`, which then triggers resolveCall synchronously.
			nextResponder = (result: unknown) => channel.resolveCall(msg.callId, result);
		}
	});
	return {
		channel,
		posted,
		respondToNext: (result: unknown) => {
			if (!nextResponder) throw new Error("no pending tool_call to respond to");
			nextResponder(result);
			nextResponder = undefined;
		},
	};
}

const fakeApi = {
	on: () => {},
	registerTool: () => {},
	registerMessageRenderer: () => {},
	sendMessage: () => {},
	registerCommand: () => {},
} as unknown as ExtensionAPI;

describe("group_architecture tool", () => {
	it("is named group_architecture (renamed from agent_network)", () => {
		const tool = createGroupArchitectureTool(makeChannel().channel);
		expect(tool.name).toBe("group_architecture");
		expect(tool.label).toBe("Group Architecture");
	});

	it("registers through the d-pi worker factory", () => {
		const registered: string[] = [];
		const postCalls: WorkerToHubMessage[] = [];
		const { factory } = createDPiExtension({
			mode: "worker",
			agentId: "agent-1",
			postToHub: (msg) => postCalls.push(msg),
		});
		const api = {
			...fakeApi,
			registerTool: (def: ToolDefinition) => {
				registered.push(def.name);
			},
		} as unknown as ExtensionAPI;
		factory(api);
		expect(registered).toContain("group_architecture");
		expect(registered).not.toContain("agent_network");
	});

	it("execute() posts a tool_call for group_architecture and renders the snapshot", async () => {
		const { channel, posted, respondToNext } = makeChannel();
		const tool = createGroupArchitectureTool(channel);

		const snapshot: GroupArchitectureSnapshot = {
			rootId: "agent-root",
			agents: [
				{
					id: "agent-root",
					name: "root",
					parentId: undefined,
					status: "ready",
					model: "anthropic/claude-sonnet-4",
					children: ["agent-child"],
				},
				{
					id: "agent-child",
					name: "worker",
					parentId: "agent-root",
					status: "busy",
					model: undefined,
					children: [],
				},
			],
		};

		// Kick off the execute() promise first; it will block until the
		// channel receives a tool_result. We resolve it asynchronously
		// from this same tick, then await the execute() promise.
		const executePromise = (
			tool as unknown as {
				execute: (id: string, params: unknown) => Promise<unknown>;
			}
		).execute("call-1", {}) as Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { agents: GroupArchitectureSnapshot["agents"] };
		}>;

		// Posted message must be a tool_call targeting the new wire name.
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({
			type: "tool_call",
			agentId: "agent-test",
			tool: "group_architecture",
			params: {},
		});
		expect(posted[0]).not.toMatchObject({ tool: "agent_network" });

		// Simulate hub returning the snapshot.
		respondToNext(snapshot);

		const result = await executePromise;

		expect(result.details.agents).toEqual(snapshot.agents);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Group Architecture");
		expect(text).toContain("root [ready]");
		expect(text).toContain("worker [busy]");
		expect(text).toContain("Use agent names");
	});

	it("surfaces an error when the channel rejects the call", async () => {
		const { channel, respondToNext } = makeChannel();
		const tool = createGroupArchitectureTool(channel);
		const executePromise = (
			tool as unknown as {
				execute: (id: string, params: unknown) => Promise<unknown>;
			}
		).execute("call-2", {}) as Promise<{
			content: Array<{ type: "text"; text: string }>;
			isError: boolean;
		}>;

		respondToNext(new Error("hub down"));
		const result = await executePromise;
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text ?? "").toContain("Failed to get group architecture");
	});
});
