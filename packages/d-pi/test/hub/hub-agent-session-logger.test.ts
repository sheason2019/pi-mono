import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HubAgentSessionLogger } from "../../src/hub/agent/hub-agent-session-logger.js";
import type { HubLogSink } from "../../src/hub/tui/hub-log.js";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4.1",
		usage: {
			input: 11,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 18,
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
		...overrides,
	};
}

function createLogs() {
	return {
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	} satisfies HubLogSink;
}

describe("HubAgentSessionLogger", () => {
	it("logs structured timings for conversation, turns, assistant messages, tools, compaction, and retries", () => {
		let now = 1_000;
		const logs = createLogs();
		const logger = new HubAgentSessionLogger({ agentId: "main", logs, now: () => now });
		const message = assistantMessage();
		const events: AgentSessionEvent[] = [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message },
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "do", partial: message },
			},
			{ type: "message_end", message },
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read_file", args: { path: "README.md" } },
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read_file",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			},
			{ type: "turn_end", message, toolResults: [] },
			{ type: "compaction_start", reason: "threshold" },
			{ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: true },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 200, errorMessage: "rate limit" },
			{ type: "auto_retry_end", success: true, attempt: 1 },
			{ type: "agent_end", messages: [message] },
		];

		for (const event of events) {
			logger.handle(event);
			now += 50;
		}

		expect(logs.info).toHaveBeenCalledWith(
			"conversation started",
			expect.objectContaining({ agentId: "main", phase: "conversation", runId: "main-1000-1" }),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"assistant message timing",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "assistant_message",
				durationMs: 100,
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4.1",
				stopReason: "stop",
				inputTokens: 11,
				outputTokens: 7,
				totalTokens: 18,
			}),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"assistant first delta timing",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "assistant_first_delta",
				durationMs: 50,
			}),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"tool timing",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "tool",
				durationMs: 50,
				toolName: "read_file",
				toolCallId: "tool-1",
				isError: false,
				toolArgsBytes: JSON.stringify({ path: "README.md" }).length,
				toolResultBytes: JSON.stringify({ content: [{ type: "text", text: "ok" }] }).length,
			}),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"turn timing",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "turn",
				durationMs: 300,
				turnIndex: 0,
				toolResults: 0,
				stopReason: "stop",
			}),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"compaction timing",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "compaction",
				durationMs: 50,
				reason: "threshold",
				aborted: false,
				willRetry: true,
			}),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"retry timing",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "retry",
				durationMs: 50,
				attempt: 1,
				success: true,
				retryDelayMs: 200,
			}),
		);
		expect(logs.info).toHaveBeenCalledWith(
			"conversation timing summary",
			expect.objectContaining({
				agentId: "main",
				runId: "main-1000-1",
				phase: "conversation",
				durationMs: 600,
				turns: 1,
				messages: 1,
			}),
		);
	});
});
