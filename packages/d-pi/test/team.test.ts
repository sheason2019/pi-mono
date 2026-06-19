import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/contracts.ts";
import { HubChannel } from "../src/extension/hub-channel.ts";
import { createDPiExtension } from "../src/extension/index.ts";
import { createTeamTool } from "../src/extension/team.ts";
import type { TeamSnapshot, WorkerToHubMessage } from "../src/types.ts";

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

describe("team tool", () => {
	it("is named team", () => {
		const tool = createTeamTool(makeChannel().channel);
		expect(tool.name).toBe("team");
		expect(tool.label).toBe("Team");
	});

	it("registers through the d-pi worker factory", () => {
		const registered: string[] = [];
		const postCalls: WorkerToHubMessage[] = [];
		const { factory } = createDPiExtension({
			mode: "worker",
			agentName: "agent-1",
			postToHub: (msg) => postCalls.push(msg),
		});
		const api = {
			...fakeApi,
			registerTool: (def: ToolDefinition) => {
				registered.push(def.name);
			},
		} as unknown as ExtensionAPI;
		factory(api);
		expect(registered).toContain("team");
		// Drift guard: the tool was renamed from agent_network. Keep this
		// assertion so a future "let's call it something else" PR cannot
		// silently re-introduce the old wire name.
		expect(registered).not.toContain("agent_network");
	});

	it("execute() posts a tool_call for team and renders the snapshot", async () => {
		const { channel, posted, respondToNext } = makeChannel();
		const tool = createTeamTool(channel);

		const snapshot: TeamSnapshot = {
			rootName: "root",
			agents: [
				{
					name: "root",
					parentName: undefined,
					status: "ready",
					model: "anthropic/claude-sonnet-4",
					children: ["worker"],
				},
				{
					name: "worker",
					parentName: "root",
					status: "busy",
					model: undefined,
					children: [],
				},
			],
			executors: [
				{
					connectId: "exec-1",
					cwd: "/tmp/client",
					attached: true,
					boundAgentName: "worker",
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
			details: { agents: TeamSnapshot["agents"]; executors: TeamSnapshot["executors"] };
		}>;

		// Posted message must be a tool_call targeting the new wire name.
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({
			type: "tool_call",
			agentName: "agent-test",
			tool: "team",
			params: {},
		});
		// Drift guard: same as above — the wire name was renamed from
		// agent_network and we want this test to fail loudly if anyone
		// re-introduces the old name.
		expect(posted[0]).not.toMatchObject({ tool: "agent_network" });

		// Simulate hub returning the snapshot.
		respondToNext(snapshot);

		const result = await executePromise;

		expect(result.details.agents).toEqual(snapshot.agents);
		expect(result.details.executors).toEqual(snapshot.executors);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Team");
		expect(text).toContain("root [ready]");
		expect(text).toContain("worker [busy]");
		expect(text).toContain("Executors");
		expect(text).toContain("exec-1 [attached] cwd=/tmp/client bound=worker");
		expect(text).toContain("Use agent names");
	});

	it("surfaces an error when the channel rejects the call", async () => {
		const { channel, respondToNext } = makeChannel();
		const tool = createTeamTool(channel);
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
		expect(result.content[0]?.text ?? "").toContain("Failed to get team");
	});
});
