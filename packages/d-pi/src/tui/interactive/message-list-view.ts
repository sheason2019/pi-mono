import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { DPiNativeAssistantMessageComponent } from "../native/components/assistant-message.ts";
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
}

export function buildDPiInteractiveMessageListView(
	snapshot: DPiInteractiveSessionStateSnapshot,
	options: DPiInteractiveStyleOptions = {},
): DPiInteractiveMessageListView {
	const lines = [
		...snapshot.messages.flatMap((message) => messageLines(message, options)),
		...snapshot.steeringMessages.map((message) => createDPiInteractiveStyle(options).dim(`steer queued: ${message}`)),
		...snapshot.followUpMessages.map((message) =>
			createDPiInteractiveStyle(options).dim(`follow-up queued: ${message}`),
		),
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
	const addStatusEntry = (entry: DPiInteractiveStatusEntry): void => {
		container.addChild(new Spacer(1));
		container.addChild(new Text(style.dim(entry.text), 1, 0));
	};
	for (const [index, message] of snapshot.messages.entries()) {
		const components = messageComponents(message, snapshot.messages, theme, markdownTheme, options);
		if (message.role === "user" && components.length > 0 && container.children.length > 0) {
			container.addChild(new Spacer(1));
		}
		for (const component of components) {
			container.addChild(component);
		}
		for (const entry of options.statusEntries ?? []) {
			if (entry.afterMessageCount === index + 1) {
				addStatusEntry(entry);
			}
		}
	}
	for (const entry of options.statusEntries ?? []) {
		if (
			entry.afterMessageCount > snapshot.messages.length ||
			(snapshot.messages.length === 0 && entry.afterMessageCount === 0)
		) {
			addStatusEntry(entry);
		}
	}
	return container;
}

export function buildDPiInteractivePendingMessagesComponent(
	snapshot: Pick<DPiInteractiveSessionStateSnapshot, "followUpMessages" | "steeringMessages">,
	options: DPiInteractiveStyleOptions = {},
): Container {
	const container = new Container();
	const style = createDPiInteractiveStyle(options);
	if (snapshot.steeringMessages.length === 0 && snapshot.followUpMessages.length === 0) {
		return container;
	}
	container.addChild(new Spacer(1));
	for (const message of snapshot.steeringMessages) {
		container.addChild(new TruncatedText(style.dim(`Steering: ${message}`), 1, 0));
	}
	for (const message of snapshot.followUpMessages) {
		container.addChild(new TruncatedText(style.dim(`Follow-up: ${message}`), 1, 0));
	}
	container.addChild(new TruncatedText(style.dim("↳ alt+up to edit all queued messages"), 1, 0));
	return container;
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
	if (isDPiMessageMirror(message)) {
		return [];
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
	if (isDPiMessageMirror(message)) {
		return [];
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

function isDPiMessageMirror(message: AgentMessage): boolean {
	return "customType" in message && message.customType === "d-pi-message";
}
