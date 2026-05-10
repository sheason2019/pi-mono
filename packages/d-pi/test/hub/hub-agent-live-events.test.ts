import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	HubAgentAdapter,
	mapAgentSessionEventToLiveRenderEvent,
	shouldSyncBoundSessionForEvent,
} from "../../src/hub/agent/hub-agent-adapter.js";

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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("hub agent live events", () => {
	it("maps assistant message lifecycle events", () => {
		const startEvent: AgentSessionEvent = {
			type: "message_start",
			message: createAssistantMessage([{ type: "thinking", thinking: "" }]),
		};
		const updateEvent: AgentSessionEvent = {
			type: "message_update",
			message: createAssistantMessage([{ type: "thinking", thinking: "step" }]),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "step",
				partial: createAssistantMessage([{ type: "thinking", thinking: "step" }]),
			},
		};
		const endEvent: AgentSessionEvent = {
			type: "message_end",
			message: createAssistantMessage([{ type: "text", text: "done" }]),
		};

		expect(mapAgentSessionEventToLiveRenderEvent(startEvent)).toEqual({
			type: "assistant_message_start",
			messageId: "assistant:1",
			message: createAssistantMessage([{ type: "thinking", thinking: "" }]),
		});
		expect(mapAgentSessionEventToLiveRenderEvent(updateEvent)).toEqual({
			type: "assistant_message_update",
			messageId: "assistant:1",
			message: createAssistantMessage([{ type: "thinking", thinking: "step" }]),
		});
		expect(mapAgentSessionEventToLiveRenderEvent(endEvent)).toEqual({
			type: "assistant_message_end",
			messageId: "assistant:1",
			message: createAssistantMessage([{ type: "text", text: "done" }]),
		});
	});

	it("maps non-assistant message lifecycle events", () => {
		const event: AgentSessionEvent = {
			type: "message_start",
			message: {
				role: "user",
				content: "hello",
				timestamp: 1,
			},
		};

		expect(mapAgentSessionEventToLiveRenderEvent(event)).toEqual({
			type: "message_start",
			messageId: "user:1",
			message: {
				role: "user",
				content: "hello",
				timestamp: 1,
			},
		});
	});

	it("maps tool events", () => {
		const toolStartEvent: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read_file",
			args: { path: "README.md" },
		};
		const toolUpdateEvent: AgentSessionEvent = {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read_file",
			args: { path: "README.md" },
			partialResult: createToolResult("partial"),
		};
		const toolEndEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read_file",
			result: createToolResult("done"),
			isError: false,
		};
		expect(mapAgentSessionEventToLiveRenderEvent(toolStartEvent)).toEqual({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read_file",
			args: { path: "README.md" },
		});
		expect(mapAgentSessionEventToLiveRenderEvent(toolUpdateEvent)).toEqual({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read_file",
			args: { path: "README.md" },
			partialResult: createToolResult("partial"),
		});
		expect(mapAgentSessionEventToLiveRenderEvent(toolEndEvent)).toEqual({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read_file",
			result: createToolResult("done"),
			isError: false,
		});
	});

	it("maps compaction to status events", () => {
		const event: AgentSessionEvent = {
			type: "compaction_start",
			reason: "manual",
		};

		expect(mapAgentSessionEventToLiveRenderEvent(event)).toEqual({
			type: "status",
			message: "Compacting conversation...",
		});
	});

	it("does not sync the full bound session for live assistant updates", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: createAssistantMessage([{ type: "thinking", thinking: "step" }]),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "step",
				partial: createAssistantMessage([{ type: "thinking", thinking: "step" }]),
			},
		};

		expect(shouldSyncBoundSessionForEvent(event)).toBe(false);
	});

	it("wakes the input queue after an abort finishes", async () => {
		const abortDone = createDeferred();
		const adapter = Object.create(HubAgentAdapter.prototype) as {
			abort: HubAgentAdapter["abort"];
			session: { isStreaming: boolean; abort: () => Promise<void> };
			sessionService: { setRunState: (...args: unknown[]) => void; syncBoundAgentSession: () => void };
			scheduleInputQueuePumpAfterSessionSettles: () => void;
		};
		adapter.session = {
			isStreaming: true,
			abort: async () => {
				await abortDone.promise;
				adapter.session.isStreaming = false;
			},
		};
		adapter.sessionService = {
			setRunState: () => {},
			syncBoundAgentSession: () => {},
		};
		adapter.scheduleInputQueuePumpAfterSessionSettles = () => {};
		const pumpSpy = vi.spyOn(adapter, "scheduleInputQueuePumpAfterSessionSettles");

		const abortPromise = adapter.abort();
		expect(pumpSpy).not.toHaveBeenCalled();
		abortDone.resolve();
		await abortPromise;

		expect(pumpSpy).toHaveBeenCalledOnce();
	});

	it("records recoverable tool errors without ending the active run", () => {
		const adapter = Object.create(HubAgentAdapter.prototype) as {
			handleSessionEvent(event: AgentSessionEvent): void;
			sessionLogger: { handle: (event: AgentSessionEvent) => void };
			emitLiveRenderEventForSessionEvent: (event: AgentSessionEvent) => void;
			sessionService: {
				recordError: (message: string, options?: { endRun?: boolean }) => void;
				syncBoundAgentSession: () => void;
			};
		};
		adapter.sessionLogger = { handle: () => {} };
		adapter.emitLiveRenderEventForSessionEvent = () => {};
		adapter.sessionService = {
			recordError: vi.fn(),
			syncBoundAgentSession: vi.fn(),
		};
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "write",
			result: createToolResult('Validation failed for tool "write"'),
			isError: true,
		};

		adapter.handleSessionEvent(event);

		expect(adapter.sessionService.recordError).toHaveBeenCalledWith('Validation failed for tool "write"', {
			endRun: false,
		});
		expect(adapter.sessionService.syncBoundAgentSession).toHaveBeenCalledOnce();
	});

	it("marks a queued turn as running before prompt preflight completes", async () => {
		const promptStarted = createDeferred();
		const promptDone = createDeferred();
		const adapter = Object.create(HubAgentAdapter.prototype) as {
			promptQueuedInputMessages(
				messages: readonly [{ text: string; messageSource: { kind: "peer"; name: string } }],
				drainMode: "auto" | "flush",
			): Promise<void>;
			session: {
				promptMessages: ReturnType<typeof vi.fn>;
			};
			sessionService: {
				setRunState: ReturnType<typeof vi.fn>;
			};
			agentId: string;
			logs: undefined;
		};
		adapter.agentId = "main";
		adapter.logs = undefined;
		adapter.sessionService = {
			setRunState: vi.fn(),
		};
		adapter.session = {
			promptMessages: vi.fn(async () => {
				promptStarted.resolve();
				await promptDone.promise;
			}),
		};

		const promptPromise = adapter.promptQueuedInputMessages(
			[{ text: "hello", messageSource: { kind: "peer", name: "peer-a" } }],
			"auto",
		);
		await promptStarted.promise;

		expect(adapter.sessionService.setRunState).toHaveBeenCalledWith(true);
		promptDone.resolve();
		await promptPromise;
	});
});
