import { describe, expect, it } from "vitest";
import type { DPiAgentMessage, DPiRuntimeError, DPiRuntimeEvent, DPiRuntimeSnapshot } from "../src/index.ts";
import { createDPiRuntimeError, isDPiRuntimeError } from "../src/runtime/errors.ts";

const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "I can help with that." }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 100,
		output: 24,
		cacheRead: 10,
		cacheWrite: 2,
		totalTokens: 136,
		cost: { input: 0.0003, output: 0.00036, cacheRead: 0.00001, cacheWrite: 0.00002, total: 0.00069 },
	},
	stopReason: "stop",
	timestamp: 1_700_000_001,
} satisfies DPiAgentMessage;

const snapshot = {
	agentName: "root",
	connectId: "connect-1",
	cwd: "/workspace/project",
	context: {
		systemPromptParts: ["workspace append", "## Agent identity\nRoot agent."],
		contextFiles: [{ path: "/workspace/project/AGENTS.md", content: "project context" }],
		skills: ["/workspace/project/skills"],
		extensions: ["/workspace/project/extensions/team.js"],
	},
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 1_700_000_000,
		},
		assistantMessage,
	],
	streaming: {
		active: true,
		message: {
			...assistantMessage,
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			timestamp: 1_700_000_003,
		},
		text: "partial",
	},
	compaction: {
		status: "idle",
		queued: false,
	},
	queues: {
		prompts: [
			{
				id: "prompt-1",
				text: "queued question",
				mode: "next",
				source: "connect",
				createdAt: 1_700_000_004,
			},
		],
		tools: [
			{
				id: "tool-1",
				name: "remote_call",
				status: "running",
				createdAt: 1_700_000_005,
				args: { agentName: "child" },
			},
		],
	},
	model: {
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		displayName: "Claude Sonnet 4.5",
		contextWindow: 200_000,
	},
	contextUsage: {
		tokens: 12_345,
		contextWindow: 200_000,
		percent: 6.1725,
	},
	tokenUsage: {
		input: 100,
		output: 24,
		cacheRead: 10,
		cacheWrite: 2,
		cost: 0.00069,
	},
	session: {
		id: "session-1",
		turnId: "turn-1",
		path: "/workspace/project/.pi/session.json",
		replacedAt: 1_700_000_006,
	},
	team: {
		rootName: "root",
		agents: [
			{
				name: "root",
				parentName: undefined,
				status: "busy",
				children: ["child"],
			},
		],
		executors: [
			{
				connectId: "connect-1",
				cwd: "/workspace/project",
				attached: true,
				boundAgentName: "root",
			},
		],
	},
} satisfies DPiRuntimeSnapshot;

describe("d-pi runtime contracts", () => {
	it("round-trips a reconstructable runtime snapshot through JSON", () => {
		const parsed = JSON.parse(JSON.stringify(snapshot)) as DPiRuntimeSnapshot;

		expect(parsed.agentName).toBe("root");
		expect(parsed.messages).toHaveLength(2);
		expect(parsed.streaming.active).toBe(true);
		expect(parsed.queues.prompts[0]).toMatchObject({ mode: "next", source: "connect" });
		expect(parsed.contextUsage).toEqual({ tokens: 12_345, contextWindow: 200_000, percent: 6.1725 });
		expect(parsed.team?.executors[0]?.boundAgentName).toBe("root");
	});

	it("round-trips normalized runtime events through JSON", () => {
		const busyError = createDPiRuntimeError("busy", "runtime is already processing a prompt", {
			retryable: true,
			details: { agentName: "root" },
		});
		const events = [
			{
				type: "assistant_stream",
				agentName: "root",
				message: assistantMessage,
				delta: "I can",
				done: false,
			},
			{
				type: "tool_start",
				agentName: "root",
				tool: {
					id: "tool-1",
					name: "remote_call",
					args: { agentName: "child" },
					startedAt: 1_700_000_007,
				},
			},
			{
				type: "tool_update",
				agentName: "root",
				toolCallId: "tool-1",
				status: "running",
				message: "waiting for child",
			},
			{
				type: "tool_end",
				agentName: "root",
				toolCallId: "tool-1",
				status: "succeeded",
				result: { ok: true },
				endedAt: 1_700_000_008,
			},
			{
				type: "queue_update",
				agentName: "root",
				queues: snapshot.queues,
			},
			{
				type: "session_replaced",
				agentName: "root",
				previousSessionId: "session-0",
				session: snapshot.session,
				messages: snapshot.messages,
			},
			{
				type: "state_update",
				agentName: "root",
				state: {
					streaming: snapshot.streaming,
					contextUsage: snapshot.contextUsage,
					tokenUsage: snapshot.tokenUsage,
				},
			},
			{
				type: "snapshot_update",
				snapshot,
			},
			{
				type: "error",
				agentName: "root",
				error: busyError,
			},
		] satisfies DPiRuntimeEvent[];

		const parsed = JSON.parse(JSON.stringify(events)) as DPiRuntimeEvent[];

		expect(parsed.map((event) => event.type)).toEqual([
			"assistant_stream",
			"tool_start",
			"tool_update",
			"tool_end",
			"queue_update",
			"session_replaced",
			"state_update",
			"snapshot_update",
			"error",
		]);
		expect(parsed[0]).toMatchObject({ type: "assistant_stream", delta: "I can", done: false });
		expect(parsed[1]).toMatchObject({ type: "tool_start", tool: { name: "remote_call" } });
		expect(parsed[2]).toMatchObject({ type: "tool_update", status: "running" });
		expect(parsed[3]).toMatchObject({ type: "tool_end", status: "succeeded", result: { ok: true } });
		expect(parsed[4]).toMatchObject({ type: "queue_update", queues: { prompts: [{ id: "prompt-1" }] } });
		expect(parsed[5]).toMatchObject({ type: "session_replaced", previousSessionId: "session-0" });
		expect(parsed[6]).toMatchObject({ type: "state_update", state: { contextUsage: snapshot.contextUsage } });
		expect(parsed[7]).toMatchObject({ type: "snapshot_update", snapshot: { agentName: "root" } });
		expect(parsed[8]).toMatchObject({
			type: "error",
			error: { name: "DPiRuntimeError", code: "busy", retryable: true },
		});
	});

	it("creates stable JSON-serializable runtime errors", () => {
		const error = createDPiRuntimeError("auth", "connect auth failed", {
			details: { connectId: "connect-1" },
		});

		const parsed = JSON.parse(JSON.stringify(error)) as DPiRuntimeError;

		expect(parsed).toEqual({
			name: "DPiRuntimeError",
			code: "auth",
			message: "connect auth failed",
			retryable: false,
			details: { connectId: "connect-1" },
		});
		expect(isDPiRuntimeError(error)).toBe(true);
		expect(isDPiRuntimeError(parsed)).toBe(true);
		expect(isDPiRuntimeError({ name: "Error", code: "auth" })).toBe(false);
	});

	it("rejects invalid runtime error shapes", () => {
		expect(
			isDPiRuntimeError({
				name: "DPiRuntimeError",
				code: "auth",
				message: "connect auth failed",
				retryable: false,
				details: () => "not json",
			}),
		).toBe(false);
		expect(
			isDPiRuntimeError({
				name: "DPiRuntimeError",
				code: "not_a_runtime_code",
				message: "connect auth failed",
				retryable: false,
			}),
		).toBe(false);
		expect(
			isDPiRuntimeError({
				name: "DPiRuntimeError",
				code: "auth",
				message: "connect auth failed",
				retryable: "false",
			}),
		).toBe(false);
	});

	it("rejects cyclic runtime error details without throwing", () => {
		type CyclicDetails = {
			self?: CyclicDetails;
		};
		const cyclicDetails: CyclicDetails = {};
		cyclicDetails.self = cyclicDetails;

		expect(() => {
			expect(
				isDPiRuntimeError({
					name: "DPiRuntimeError",
					code: "auth",
					message: "connect auth failed",
					retryable: false,
					details: cyclicDetails,
				}),
			).toBe(false);
		}).not.toThrow();
	});
});
