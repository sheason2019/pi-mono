import type * as acp from "@agentclientprotocol/sdk";
import type { AssistantMessage } from "@sheason/pi-ai";
import type { AgentToolResult } from "@sheason/pi-coding-agent";
import type { GuestAgentMessagePayload, HubAgentViewItem, HubAgentViewModel } from "../hub/index.js";
import type { PeerAppState, PeerLiveSnapshot, PeerLiveToolExecution } from "../peer/state/peer-app-state.js";

export interface AcpGuestProjectionOptions {
	appState: PeerAppState;
	agentId: string;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
}

export class AcpGuestProjection {
	private readonly items: HubAgentViewItem[] = [];
	private readonly toolsById = new Map<string, PeerLiveToolExecution>();
	private readonly finalizedToolCallIds = new Set<string>();
	private currentAssistant: AssistantMessage | undefined;
	private currentAssistantMessageId: string | undefined;
	private isRunning = false;
	private runStartedAt: string | undefined;
	private lastRunStartedAt: string | undefined;
	private lastRunEndedAt: string | undefined;
	private lastRunDurationMs: number | undefined;
	private lastRunEndReason: "completed" | "interrupted" | "error" | undefined;
	private assistantSequence = 0;

	constructor(private readonly options: AcpGuestProjectionOptions) {
		this.publish();
	}

	appendUserPrompt(text: string): void {
		this.items.push({
			type: "message",
			message: {
				role: "user",
				content: text,
				timestamp: Date.now(),
			},
		});
		this.startRun();
		this.publish();
	}

	appendInboundAgentMessage(payload: GuestAgentMessagePayload): string {
		const prompt = [
			"[D-Pi agent message]",
			`from: ${payload.fromAgentId}`,
			`to: ${payload.toAgentId}`,
			`sent_at: ${payload.sentAt}`,
			"",
			payload.message,
		].join("\n");
		this.appendUserPrompt(prompt);
		return prompt;
	}

	applySessionUpdate(notification: acp.SessionNotification): void {
		const update = notification.update;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				this.appendAssistantChunk(update);
				return;
			case "tool_call":
				this.upsertTool({
					toolCallId: update.toolCallId,
					toolName: update.title,
					args: toRecord(update.rawInput),
					partialResult: contentToToolResult(update.content),
					result:
						update.status === "completed"
							? contentToToolResult(update.content, update.rawOutput, "completed")
							: undefined,
					isError: update.status === "failed",
				});
				return;
			case "tool_call_update":
				this.mergeToolUpdate(update);
				return;
			case "agent_thought_chunk":
			case "plan":
				this.setStatusMessage(getDisplayText(update) ?? update.sessionUpdate);
				return;
			default:
				return;
		}
	}

	completeTurn(stopReason: string): void {
		this.isRunning = false;
		this.lastRunEndedAt = new Date().toISOString();
		this.lastRunEndReason = stopReason === "cancelled" || stopReason === "canceled" ? "interrupted" : "completed";
		if (this.runStartedAt) {
			this.lastRunDurationMs = Math.max(0, Date.parse(this.lastRunEndedAt) - Date.parse(this.runStartedAt));
		}
		if (this.currentAssistant) {
			this.currentAssistant.stopReason = this.lastRunEndReason === "interrupted" ? "aborted" : "stop";
		}
		this.currentAssistant = undefined;
		this.currentAssistantMessageId = undefined;
		this.publish();
	}

	failTurn(error: unknown): void {
		this.isRunning = false;
		this.lastRunEndedAt = new Date().toISOString();
		this.lastRunEndReason = "error";
		if (this.currentAssistant) {
			this.currentAssistant.stopReason = "error";
			this.currentAssistant.errorMessage = error instanceof Error ? error.message : String(error);
		}
		this.items.push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `ACP error: ${error instanceof Error ? error.message : String(error)}` }],
				timestamp: Date.now(),
				stopReason: "error",
			} as AssistantMessage,
		});
		this.currentAssistant = undefined;
		this.currentAssistantMessageId = undefined;
		this.publish();
	}

	private appendAssistantChunk(update: Extract<acp.SessionUpdate, { sessionUpdate: "agent_message_chunk" }>): void {
		const text = getDisplayText(update);
		if (!text) {
			return;
		}
		this.ensureAssistantMessage(update.messageId ?? undefined);
		const currentAssistant = this.currentAssistant;
		if (!currentAssistant) {
			return;
		}
		const first = currentAssistant.content[0];
		if (first?.type === "text") {
			first.text += text;
		} else {
			currentAssistant.content.push({ type: "text", text });
		}
		this.publish();
	}

	private ensureAssistantMessage(messageId: string | undefined): void {
		if (this.currentAssistant && (messageId === undefined || messageId === this.currentAssistantMessageId)) {
			return;
		}
		this.assistantSequence += 1;
		this.currentAssistant = createAssistantMessage("", this.assistantSequence);
		this.currentAssistantMessageId = messageId;
		this.items.push({ type: "message", message: this.currentAssistant });
	}

	private mergeToolUpdate(update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>): void {
		const existing = this.toolsById.get(update.toolCallId);
		this.upsertTool({
			toolCallId: update.toolCallId,
			toolName: update.title ?? existing?.toolName ?? update.toolCallId,
			args: toRecord(update.rawInput) ?? existing?.args,
			partialResult: contentToToolResult(update.content ?? undefined) ?? existing?.partialResult,
			result:
				update.status === "completed"
					? (contentToToolResult(update.content ?? undefined, update.rawOutput, "completed") ?? existing?.result)
					: update.status === "failed"
						? (contentToToolResult(update.content ?? undefined, update.rawOutput, "failed") ?? existing?.result)
						: existing?.result,
			isError: update.status === "failed" ? true : existing?.isError,
		});
	}

	private upsertTool(tool: PeerLiveToolExecution): void {
		const next = { ...this.toolsById.get(tool.toolCallId), ...tool };
		this.toolsById.set(tool.toolCallId, next);
		this.ensureAssistantToolCall(tool);
		if (next.result !== undefined || next.isError === true) {
			this.appendToolResult(next);
			this.finalizedToolCallIds.add(next.toolCallId);
			this.currentAssistant = undefined;
			this.currentAssistantMessageId = undefined;
		}
		this.publish();
	}

	private appendToolResult(tool: PeerLiveToolExecution): void {
		if (
			this.items.some(
				(item) =>
					item.type === "message" &&
					item.message.role === "toolResult" &&
					item.message.toolCallId === tool.toolCallId,
			)
		) {
			return;
		}
		const result =
			tool.result ??
			tool.partialResult ??
			contentToToolResult(undefined, undefined, tool.isError ? "failed" : "completed");
		this.items.push({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				content: result?.content ?? [{ type: "text", text: tool.isError ? "failed" : "completed" }],
				details: result?.details,
				isError: tool.isError ?? false,
				timestamp: Date.now(),
			},
		});
	}

	private ensureAssistantToolCall(tool: PeerLiveToolExecution): void {
		this.ensureAssistantMessage(undefined);
		if (!this.currentAssistant) {
			return;
		}
		const existing = this.currentAssistant.content.find(
			(content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
				content.type === "toolCall" && content.id === tool.toolCallId,
		);
		if (existing) {
			existing.name = tool.toolName;
			existing.arguments = tool.args ?? {};
			return;
		}
		this.currentAssistant.content.push({
			type: "toolCall",
			id: tool.toolCallId,
			name: tool.toolName,
			arguments: tool.args ?? {},
		});
	}

	private setStatusMessage(message: string): void {
		this.publish(message);
	}

	private startRun(): void {
		this.isRunning = true;
		this.runStartedAt = new Date().toISOString();
		this.lastRunStartedAt = this.runStartedAt;
		this.lastRunEndedAt = undefined;
		this.lastRunDurationMs = undefined;
		this.lastRunEndReason = undefined;
		this.currentAssistant = undefined;
		this.currentAssistantMessageId = undefined;
		this.toolsById.clear();
		this.finalizedToolCallIds.clear();
	}

	private publish(statusMessage?: string): void {
		const liveToolExecutions = [...this.toolsById.values()].filter(
			(tool) => !this.finalizedToolCallIds.has(tool.toolCallId),
		);
		const live: PeerLiveSnapshot = {
			streamingMessageId: this.currentAssistant ? getMessageId(this.currentAssistant) : undefined,
			streamingMessageIndex: this.currentAssistant ? this.items.length - 1 : undefined,
			streamingMessage: this.currentAssistant,
			toolExecutions: liveToolExecutions,
			statusMessage,
		};
		this.options.appState.applyLocalAgentProjection(this.createAgentView(live), live);
	}

	private createAgentView(live: PeerLiveSnapshot): HubAgentViewModel {
		return {
			agentId: this.options.agentId,
			kind: "guest",
			sessionId: this.options.sessionId ?? `guest-acp-${this.options.agentId}`,
			cwd: this.options.cwd,
			sessionFile: this.options.sessionFile ?? "",
			protocolVersion: 3,
			status: {
				isRunning: this.isRunning,
				runStartedAt: this.runStartedAt,
				lastRunStartedAt: this.lastRunStartedAt,
				lastRunEndedAt: this.lastRunEndedAt,
				lastRunDurationMs: this.lastRunDurationMs,
				lastRunEndReason: this.lastRunEndReason,
			},
			queue: { messages: [], size: 0 },
			context: {
				model: null,
				thinkingLevel: "off",
				pendingToolCallIds: live.toolExecutions
					.filter((tool) => tool.result === undefined && !tool.isError)
					.map((tool) => tool.toolCallId),
			},
			items: this.items.map((item) => ({ ...item })),
			live: {
				streamingMessageId: live.streamingMessageId,
				streamingMessageIndex: live.streamingMessageIndex,
				itemIndicesById: {},
				toolOrder: live.toolExecutions.map((tool) => tool.toolCallId),
				toolsById: Object.fromEntries(
					live.toolExecutions.map((tool) => [
						tool.toolCallId,
						{
							toolCallId: tool.toolCallId,
							toolName: tool.toolName,
							args: tool.args,
							partialResult: tool.partialResult,
							result: tool.result,
							isError: tool.isError,
						},
					]),
				),
				statusMessage: live.statusMessage,
			},
			availableModels: [],
			availableThinkingLevels: [],
			diagnostics: [],
		};
	}
}

function getMessageId(message: AssistantMessage): string {
	return `assistant:${message.timestamp}`;
}

function createAssistantMessage(text: string, sequence: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "acp",
		model: "external-acp-agent",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now() + sequence,
	};
}

function getDisplayText(update: acp.ContentChunk | acp.Plan): string | undefined {
	if ("content" in update && update.content.type === "text") {
		return update.content.text;
	}
	if ("entries" in update) {
		return update.entries.map((entry) => entry.content).join("\n");
	}
	return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function contentToToolResult(
	content: acp.ToolCallContent[] | undefined | null,
	rawOutput?: unknown,
	fallbackText?: string,
): AgentToolResult<unknown> | undefined {
	const textParts =
		content
			?.map((entry) => (entry.type === "content" && entry.content.type === "text" ? entry.content.text : undefined))
			.filter((text): text is string => text !== undefined) ?? [];
	if (textParts.length === 0 && rawOutput === undefined && fallbackText === undefined) {
		return undefined;
	}
	return {
		content:
			textParts.length > 0
				? textParts.map((text) => ({ type: "text" as const, text }))
				: [{ type: "text", text: rawOutput === undefined ? (fallbackText ?? "") : JSON.stringify(rawOutput) }],
		details: rawOutput,
	};
}
