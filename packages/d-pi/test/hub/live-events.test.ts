import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LIVE_RENDER_EVENT_TYPES, type LiveRenderEvent } from "../../src/hub/transport/live-events.js";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4.1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function createToolResult(text: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details: { text },
	};
}

describe("live render events", () => {
	it("exposes stable runtime event names", () => {
		expect(LIVE_RENDER_EVENT_TYPES).toEqual([
			"message_start",
			"message_update",
			"message_end",
			"assistant_message_start",
			"assistant_message_update",
			"assistant_message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"status",
		]);
	});

	it("supports assistant message lifecycle payloads", () => {
		const event: LiveRenderEvent = {
			type: "assistant_message_update",
			messageId: "msg-1",
			message: createAssistantMessage([{ type: "thinking", thinking: "step by step" }]),
		};

		expect(event).toEqual({
			type: "assistant_message_update",
			messageId: "msg-1",
			message: createAssistantMessage([{ type: "thinking", thinking: "step by step" }]),
		});
	});

	it("supports tool lifecycle payloads", () => {
		const event: LiveRenderEvent = {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read_file",
			result: createToolResult("done"),
			isError: false,
		};

		expect(event).toEqual({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read_file",
			result: createToolResult("done"),
			isError: false,
		});
	});

	it("supports status payloads", () => {
		const statusEvent: LiveRenderEvent = {
			type: "status",
			message: "Compacting conversation...",
		};

		expect(statusEvent).toEqual({
			type: "status",
			message: "Compacting conversation...",
		});
	});
});
