import type { AgentMessage } from "@sheason/pi-agent-core";
import type { AssistantMessage } from "@sheason/pi-ai";
import type { AgentSessionEvent } from "@sheason/pi-coding-agent";
import type { HubLogDetails, HubLogSink } from "../tui/hub-log.js";

export interface HubAgentSessionLoggerOptions {
	agentId: string;
	logs?: HubLogSink;
	now?: () => number;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function getStopReason(message: AgentMessage): string | undefined {
	if (!isAssistantMessage(message)) {
		return undefined;
	}
	return typeof message.stopReason === "string" ? message.stopReason : undefined;
}

function addAssistantUsage(details: HubLogDetails, message: AssistantMessage): void {
	details.api = message.api;
	details.provider = message.provider;
	details.model = message.model;
	details.stopReason = message.stopReason;
	details.inputTokens = message.usage.input;
	details.outputTokens = message.usage.output;
	details.totalTokens = message.usage.totalTokens;
}

export class HubAgentSessionLogger {
	private readonly agentId: string;
	private readonly logs: HubLogSink | undefined;
	private readonly now: () => number;
	private runStartedAt: number | undefined;
	private runId: string | undefined;
	private runSequence = 0;
	private nextTurnIndex = 0;
	private activeTurn: { startedAt: number; turnIndex: number } | undefined;
	private assistantMessageStartedAt: number | undefined;
	private assistantFirstDeltaLogged = false;
	private assistantMessageCount = 0;
	private readonly toolStartedAt = new Map<string, { startedAt: number; argsBytes: number }>();
	private compactionStartedAt: number | undefined;
	private retryStartedAt: number | undefined;
	private retryDelayMs: number | undefined;

	constructor(options: HubAgentSessionLoggerOptions) {
		this.agentId = options.agentId;
		this.logs = options.logs;
		this.now = options.now ?? (() => Date.now());
	}

	handle(event: AgentSessionEvent): void {
		if (!this.logs) {
			return;
		}
		switch (event.type) {
			case "agent_start":
				this.handleAgentStart();
				return;
			case "agent_end":
				this.handleAgentEnd();
				return;
			case "turn_start":
				this.handleTurnStart();
				return;
			case "turn_end":
				this.handleTurnEnd(event);
				return;
			case "message_start":
				this.handleMessageStart(event.message);
				return;
			case "message_update":
				this.handleMessageUpdate(event.message);
				return;
			case "message_end":
				this.handleMessageEnd(event.message);
				return;
			case "tool_execution_start":
				this.toolStartedAt.set(event.toolCallId, {
					startedAt: this.now(),
					argsBytes: jsonByteLength(event.args),
				});
				return;
			case "tool_execution_end":
				this.handleToolExecutionEnd(event);
				return;
			case "compaction_start":
				this.compactionStartedAt = this.now();
				return;
			case "compaction_end":
				this.handleCompactionEnd(event);
				return;
			case "auto_retry_start":
				this.retryStartedAt = this.now();
				this.retryDelayMs = event.delayMs;
				return;
			case "auto_retry_end":
				this.handleRetryEnd(event);
				return;
			default:
				return;
		}
	}

	private handleAgentStart(): void {
		const now = this.now();
		this.runStartedAt = now;
		this.runSequence += 1;
		this.runId = `${this.agentId}-${now}-${this.runSequence}`;
		this.nextTurnIndex = 0;
		this.activeTurn = undefined;
		this.assistantMessageStartedAt = undefined;
		this.assistantFirstDeltaLogged = false;
		this.assistantMessageCount = 0;
		this.toolStartedAt.clear();
		this.compactionStartedAt = undefined;
		this.retryStartedAt = undefined;
		this.retryDelayMs = undefined;
		this.info("conversation started", { phase: "conversation" });
	}

	private handleAgentEnd(): void {
		const durationMs = this.durationSince(this.runStartedAt);
		this.info("conversation timing summary", {
			phase: "conversation",
			durationMs,
			turns: this.nextTurnIndex,
			messages: this.assistantMessageCount,
		});
		this.runStartedAt = undefined;
		this.activeTurn = undefined;
		this.assistantMessageStartedAt = undefined;
		this.assistantFirstDeltaLogged = false;
		this.toolStartedAt.clear();
		this.compactionStartedAt = undefined;
		this.retryStartedAt = undefined;
		this.retryDelayMs = undefined;
	}

	private handleTurnStart(): void {
		this.activeTurn = {
			startedAt: this.now(),
			turnIndex: this.nextTurnIndex,
		};
		this.nextTurnIndex += 1;
	}

	private handleTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
		const turn = this.activeTurn;
		this.info("turn timing", {
			phase: "turn",
			durationMs: this.durationSince(turn?.startedAt),
			turnIndex: turn?.turnIndex ?? Math.max(0, this.nextTurnIndex - 1),
			toolResults: event.toolResults.length,
			stopReason: getStopReason(event.message) ?? null,
		});
		this.activeTurn = undefined;
	}

	private handleMessageStart(message: AgentMessage): void {
		if (isAssistantMessage(message)) {
			this.assistantMessageStartedAt = this.now();
			this.assistantFirstDeltaLogged = false;
		}
	}

	private handleMessageUpdate(message: AgentMessage): void {
		if (!isAssistantMessage(message) || this.assistantFirstDeltaLogged) {
			return;
		}
		this.assistantFirstDeltaLogged = true;
		this.info("assistant first delta timing", {
			phase: "assistant_first_delta",
			durationMs: this.durationSince(this.assistantMessageStartedAt),
		});
	}

	private handleMessageEnd(message: AgentMessage): void {
		if (!isAssistantMessage(message)) {
			return;
		}
		this.assistantMessageCount += 1;
		const details: HubLogDetails = {
			phase: "assistant_message",
			durationMs: this.durationSince(this.assistantMessageStartedAt),
		};
		addAssistantUsage(details, message);
		this.info("assistant message timing", details);
		this.assistantMessageStartedAt = undefined;
		this.assistantFirstDeltaLogged = false;
	}

	private handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
		const tool = this.toolStartedAt.get(event.toolCallId);
		this.toolStartedAt.delete(event.toolCallId);
		this.info("tool timing", {
			phase: "tool",
			durationMs: this.durationSince(tool?.startedAt),
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			toolArgsBytes: tool?.argsBytes ?? 0,
			toolResultBytes: jsonByteLength(event.result),
		});
	}

	private handleCompactionEnd(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): void {
		const details: HubLogDetails = {
			phase: "compaction",
			durationMs: this.durationSince(this.compactionStartedAt),
			reason: event.reason,
			aborted: event.aborted,
			willRetry: event.willRetry,
		};
		if (event.errorMessage) {
			details.error = event.errorMessage;
		}
		this.info("compaction timing", details);
		this.compactionStartedAt = undefined;
	}

	private handleRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): void {
		const details: HubLogDetails = {
			phase: "retry",
			durationMs: this.durationSince(this.retryStartedAt),
			attempt: event.attempt,
			success: event.success,
			retryDelayMs: this.retryDelayMs ?? 0,
		};
		if (event.finalError) {
			details.error = event.finalError;
		}
		this.info("retry timing", details);
		this.retryStartedAt = undefined;
		this.retryDelayMs = undefined;
	}

	private durationSince(startedAt: number | undefined): number {
		if (startedAt === undefined) {
			return 0;
		}
		return Math.max(0, this.now() - startedAt);
	}

	private info(message: string, details: HubLogDetails): void {
		try {
			this.logs?.info(message, {
				agentId: this.agentId,
				runId: this.runId ?? null,
				...details,
			});
		} catch {
			// Observability must never affect agent execution.
		}
	}
}

function jsonByteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return 0;
	}
}
