import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../extension/contracts.ts";
import type { DPiTranscriptItem } from "../../runtime/transcript/projector.ts";
import { DPiNativeAssistantMessageComponent } from "../native/components/assistant-message.ts";
import { DPiNativeDynamicBorder } from "../native/components/dynamic-border.ts";
import { DPiNativeToolExecutionComponent } from "../native/components/tool-execution.ts";
import { DPiNativeUserMessageComponent } from "../native/components/user-message.ts";
import { createDPiNativeTheme, getDPiNativeMarkdownTheme } from "../native/theme/theme.ts";
import type { DPiInteractiveSessionStateSnapshot, DPiInteractiveTurnStats } from "./agent-session-proxy.ts";
import { createDPiInteractiveStyle, type DPiInteractiveStyleOptions } from "./style.ts";

export interface DPiInteractiveMessageListView {
	text: string;
}

export interface DPiInteractiveStatusEntry {
	afterMessageCount: number;
	text: string;
}

export interface DPiInteractiveMessageListComponentOptions extends DPiInteractiveStyleOptions {
	statusEntries?: readonly DPiInteractiveStatusEntry[];
	cwd?: string;
	toolsExpanded?: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
	messageRenderers?: Readonly<Record<string, MessageRenderer<unknown>>>;
}

export function buildDPiInteractiveMessageListView(
	snapshot: DPiInteractiveSessionStateSnapshot,
	options: DPiInteractiveStyleOptions = {},
): DPiInteractiveMessageListView {
	const lines = [
		...snapshotTranscriptItems(snapshot).flatMap((item) => itemLines(item, options)),
		...snapshot.steeringMessages.map((message) => createDPiInteractiveStyle(options).dim(`steer queued: ${message}`)),
	];
	return { text: lines.join("\n") };
}

export function buildDPiInteractiveMessageListComponent(
	snapshot: DPiInteractiveSessionStateSnapshot,
	options: DPiInteractiveMessageListComponentOptions = {},
): Container {
	const container = new Container();
	const theme = createDPiNativeTheme(options);
	const markdownTheme = getDPiNativeMarkdownTheme(theme);
	const style = createDPiInteractiveStyle(options);
	const items = snapshotTranscriptItems(snapshot);
	const statusEntries = items.some((item) => item.type === "turn_stats") ? [] : (options.statusEntries ?? []);
	const addStatusEntry = (entry: DPiInteractiveStatusEntry): void => {
		container.addChild(new Spacer(1));
		container.addChild(new Text(style.dim(entry.text), 1, 0));
	};
	for (const [index, item] of items.entries()) {
		const components = itemComponents(item, snapshot.messages, theme, markdownTheme, options);
		if (
			item.type === "message" &&
			item.message.role === "user" &&
			components.length > 0 &&
			container.children.length > 0
		) {
			container.addChild(new Spacer(1));
		}
		for (const component of components) {
			container.addChild(component);
		}
		for (const entry of statusEntries) {
			if (entry.afterMessageCount === index + 1) {
				addStatusEntry(entry);
			}
		}
	}
	for (const entry of statusEntries) {
		if (entry.afterMessageCount > items.length || (items.length === 0 && entry.afterMessageCount === 0)) {
			addStatusEntry(entry);
		}
	}
	return container;
}

function snapshotTranscriptItems(snapshot: DPiInteractiveSessionStateSnapshot): DPiTranscriptItem[] {
	return (
		snapshot.transcriptItems?.map((item) => ({ ...item })) ??
		snapshot.messages.map((message, index) => ({
			id: `message-${index}`,
			type: "message" as const,
			message,
			timestamp: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		}))
	);
}

function itemComponents(
	item: DPiTranscriptItem,
	messages: readonly AgentMessage[],
	theme: ReturnType<typeof createDPiNativeTheme>,
	markdownTheme: ReturnType<typeof getDPiNativeMarkdownTheme>,
	options: DPiInteractiveMessageListComponentOptions,
): Component[] {
	if (item.type === "message") {
		return messageComponents(item.message, messages, theme, markdownTheme, options);
	}
	if (item.type === "boundary") {
		return messageComponents(
			{
				role: "custom",
				customType: "compact-divider",
				content: item.label,
				display: true,
				details: {
					...(item.summary === undefined ? {} : { summary: item.summary }),
					...(item.tokensBefore === undefined ? {} : { tokensBefore: item.tokensBefore }),
					...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
					...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
				},
				timestamp: item.timestamp,
			},
			messages,
			theme,
			markdownTheme,
			options,
		);
	}
	if (item.type === "tool_state") {
		return [
			new DPiNativeToolExecutionComponent(
				{ type: "toolCall", id: item.toolCallId, name: item.toolName, arguments: recordArgs(item.args) },
				transcriptToolResult(item),
				{
					theme,
					cwd: options.cwd,
					expanded: options.toolsExpanded,
					showImages: options.showImages,
					imageWidthCells: options.imageWidthCells,
				},
			),
		];
	}
	if (item.type === "turn_stats") {
		return [
			new Spacer(1),
			new Text(
				theme.fg("muted", buildDPiInteractiveStatusView({ isStreaming: false }, item, { color: false }).text),
				1,
				0,
			),
		];
	}
	return [new Text(theme.fg(item.level === "error" ? "error" : "muted", item.text), 1, 0)];
}

export function buildDPiInteractivePendingMessagesComponent(
	snapshot: Pick<DPiInteractiveSessionStateSnapshot, "steeringMessages">,
	options: DPiInteractiveStyleOptions = {},
): Container {
	const container = new Container();
	const style = createDPiInteractiveStyle(options);
	if (snapshot.steeringMessages.length === 0) {
		return container;
	}
	container.addChild(new Spacer(1));
	for (const message of snapshot.steeringMessages) {
		container.addChild(new TruncatedText(style.dim(`Steering: ${message}`), 1, 0));
	}
	container.addChild(new TruncatedText(style.dim("↳ alt+up to edit all queued messages"), 1, 0));
	return container;
}

function itemLines(item: DPiTranscriptItem, options: DPiInteractiveStyleOptions): string[] {
	const style = createDPiInteractiveStyle(options);
	if (item.type === "message") {
		return messageLines(item.message, options);
	}
	if (item.type === "boundary") {
		return messageLines(
			{
				role: "custom",
				customType: "compact-divider",
				content: item.label,
				display: true,
				details: {
					...(item.summary === undefined ? {} : { summary: item.summary }),
					...(item.tokensBefore === undefined ? {} : { tokensBefore: item.tokensBefore }),
				},
				timestamp: item.timestamp,
			},
			options,
		);
	}
	if (item.type === "tool_state") {
		return blockLines(`[tool] ${item.toolName}\n${transcriptToolText(item)}`.trim(), style.accent);
	}
	if (item.type === "turn_stats") {
		return ["", style.dim(buildDPiInteractiveStatusView({ isStreaming: false }, item, { color: false }).text)];
	}
	return blockLines(item.text, item.level === "error" ? style.error : style.muted);
}

export function buildDPiInteractiveStatusView(
	state: Pick<DPiInteractiveSessionStateSnapshot, "isStreaming">,
	stats: DPiInteractiveTurnStats | undefined,
	options: DPiInteractiveStyleOptions = {},
): DPiInteractiveMessageListView {
	const style = createDPiInteractiveStyle(options);
	if (state.isStreaming) {
		return { text: `${style.accent("⠋")} ${style.muted("Working...")}` };
	}
	if (!stats) {
		return { text: "" };
	}
	const parts: string[] = [];
	if (stats.output > 0) {
		parts.push(`TPS ${stats.tps.toFixed(1)} tok/s`);
	}
	parts.push(`out ${formatCompactTokens(stats.output)}`);
	parts.push(`in ${formatCompactTokens(stats.input)}`);
	if (stats.cacheRead > 0 || stats.cacheWrite > 0) {
		parts.push(`cache r/w ${formatCompactTokens(stats.cacheRead)}/${formatCompactTokens(stats.cacheWrite)}`);
	}
	parts.push(`total ${formatCompactTokens(stats.total)}`);
	parts.push(`${stats.duration.toFixed(1)}s`);
	return { text: style.dim(parts.join(", ")) };
}

function messageComponents(
	message: AgentMessage,
	messages: readonly AgentMessage[],
	theme: ReturnType<typeof createDPiNativeTheme>,
	markdownTheme: ReturnType<typeof getDPiNativeMarkdownTheme>,
	options: DPiInteractiveMessageListComponentOptions,
): Component[] {
	const custom = customMessageComponent(message, theme, options);
	if (custom) {
		return [custom];
	}
	if (message.role === "user") {
		const text = stripDPiMetaWrapper(contentText(message.content));
		if (!text) {
			return [];
		}
		return [
			new DPiNativeUserMessageComponent(text, {
				theme,
				markdownTheme,
			}),
		];
	}
	if (isCompactDividerMessage(message)) {
		const divider = new Container();
		const summary = compactDividerSummary(message);
		divider.addChild(new Spacer(1));
		divider.addChild(new DPiNativeDynamicBorder((text) => theme.fg("borderMuted", text)));
		divider.addChild(new Text(theme.fg("muted", compactDividerLabel(message)), 1, 0));
		divider.addChild(new Spacer(1));
		if (summary) {
			divider.addChild(
				new Markdown(summary, 1, 0, markdownTheme, {
					color: (text: string) => theme.fg("muted", text),
				}),
			);
		}
		divider.addChild(new Spacer(1));
		return [divider];
	}
	if (message.role === "toolResult") {
		return [];
	}
	if (message.role !== "assistant") {
		const text = contentText("content" in message ? message.content : "");
		return text ? [new Text(theme.fg("muted", text), 1, 0)] : [];
	}
	const assistant = normalizeAssistantMessage(message);
	return [
		new DPiNativeAssistantMessageComponent(assistant, {
			theme,
			markdownTheme,
		}),
		...assistant.content
			.filter((part): part is ToolCall => part.type === "toolCall")
			.map(
				(toolCall) =>
					new DPiNativeToolExecutionComponent(toolCall, findToolResult(messages, toolCall.id), {
						theme,
						cwd: options.cwd,
						expanded: options.toolsExpanded,
						showImages: options.showImages,
						imageWidthCells: options.imageWidthCells,
					}),
			),
	];
}

function customMessageComponent(
	message: AgentMessage,
	theme: ReturnType<typeof createDPiNativeTheme>,
	options: DPiInteractiveMessageListComponentOptions,
): Component | undefined {
	if (!("customType" in message) || typeof message.customType !== "string") {
		return undefined;
	}
	const renderer = options.messageRenderers?.[message.customType];
	if (!renderer) {
		return undefined;
	}
	return renderer(
		message,
		{ expanded: options.toolsExpanded === true },
		{
			bg: (name, text) => theme.bg(name as Parameters<typeof theme.bg>[0], text),
			fg: (name, text) => theme.fg(name as Parameters<typeof theme.fg>[0], text),
		},
	);
}

function normalizeAssistantMessage(message: AgentMessage): AssistantMessage {
	const rawContent = "content" in message ? message.content : "";
	const content = Array.isArray(rawContent) ? rawContent : [{ type: "text" as const, text: contentText(rawContent) }];
	return { ...message, role: "assistant", content } as AssistantMessage;
}

function findToolResult(messages: readonly AgentMessage[], toolCallId: string): ToolResultMessage | undefined {
	return messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
}

function transcriptToolResult(item: Extract<DPiTranscriptItem, { type: "tool_state" }>): ToolResultMessage | undefined {
	if (item.status === "running") {
		return undefined;
	}
	return {
		role: "toolResult",
		toolCallId: item.toolCallId,
		toolName: item.toolName,
		content: transcriptToolResultContent(item),
		isError: item.status === "failed" || item.status === "cancelled",
		timestamp: item.timestamp,
	};
}

function recordArgs(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function transcriptToolResultContent(
	item: Extract<DPiTranscriptItem, { type: "tool_state" }>,
): ToolResultMessage["content"] {
	const result = item.result;
	if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
		return result.content as ToolResultMessage["content"];
	}
	return [{ type: "text", text: transcriptToolText(item) }];
}

function transcriptToolText(item: Extract<DPiTranscriptItem, { type: "tool_state" }>): string {
	if (item.error) {
		return item.error;
	}
	const result = item.result;
	if (typeof result === "string") {
		return result;
	}
	if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
		return result.content
			.map((part) =>
				typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
					? part.text
					: "",
			)
			.join("");
	}
	return item.status;
}

function messageLines(message: AgentMessage, options: DPiInteractiveStyleOptions): string[] {
	const style = createDPiInteractiveStyle(options);
	if (message.role === "user") {
		return blockLines(stripDPiMetaWrapper(contentText(message.content)), style.userMessage);
	}
	if (message.role === "assistant") {
		return message.content.flatMap((part): string[] => {
			if (part.type === "thinking") {
				return blockLines(part.thinking, style.thinking);
			}
			if (part.type === "text") {
				return blockLines(part.text);
			}
			if (part.type === "toolCall") {
				return blockLines(`[tool] ${part.name}`, style.accent);
			}
			return [];
		});
	}
	if (isCompactDividerMessage(message)) {
		const summary = compactDividerSummary(message);
		return [
			"",
			style.dim(`──────────────── ${compactDividerLabel(message)} ────────────────`),
			"",
			...(summary ? summary.split("\n").map((line) => style.dim(` ${line}`)) : []),
			"",
		];
	}
	return [];
}

function blockLines(text: string, color: (line: string) => string = (line) => line): string[] {
	const lines = text.split("\n");
	return ["", ...lines.map((line) => color(` ${line}`)), ""];
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
					return part.text;
				}
				return "";
			})
			.join("");
	}
	return "";
}

function formatCompactTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function stripDPiMetaWrapper(text: string): string {
	const match = text.match(/^\[meta\((?:.|\n)*?\)\]\s*\n?((?:.|\n)*)$/);
	return match?.[1] ?? text;
}

function isCompactDividerMessage(message: AgentMessage): boolean {
	return "customType" in message && message.customType === "compact-divider";
}

function compactDividerLabel(message: AgentMessage): string {
	if (!("content" in message)) {
		return "Compact completed";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (typeof content === "object" && content !== null && !Array.isArray(content)) {
		const record = content as Record<string, unknown>;
		if (typeof record.label === "string") {
			return record.label;
		}
	}
	return "Compact completed";
}

function compactDividerSummary(message: AgentMessage): string | undefined {
	if (!("details" in message) || typeof message.details !== "object" || message.details === null) {
		return undefined;
	}
	const details = message.details as Record<string, unknown>;
	if (typeof details.summary === "string" && details.summary.trim()) {
		return details.summary;
	}
	if (typeof details.result === "object" && details.result !== null) {
		const result = details.result as Record<string, unknown>;
		if (typeof result.summary === "string" && result.summary.trim()) {
			return result.summary;
		}
	}
	return undefined;
}
