import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Box, type Component, Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { z } from "zod";
import { dPiMessageMetaSchema, extractDPiMeta } from "../../message-meta.ts";
import type { DPiTranscriptItem } from "../../runtime/transcript/projector.ts";
import { DPiNativeAssistantMessageComponent } from "../native/components/assistant-message.ts";
import { DPiNativeDynamicBorder } from "../native/components/dynamic-border.ts";
import { DPiNativeToolExecutionComponent } from "../native/components/tool-execution.ts";
import { DPiNativeUserMessageComponent } from "../native/components/user-message.ts";
import { createDPiNativeTheme, getDPiNativeMarkdownTheme } from "../native/theme/theme.ts";
import type { DPiInteractiveSessionStateSnapshot, DPiInteractiveTurnStats } from "./agent-session-proxy.ts";
import { createDPiInteractiveStyle, type DPiInteractiveStyleOptions } from "./style.ts";

const textPartSchema = z.object({ type: z.literal("text"), text: z.string().catch("") });
const imagePartSchema = z.object({
	type: z.literal("image"),
	data: z.string(),
	mimeType: z.string(),
});
const contentPartSchema = z.union([textPartSchema, imagePartSchema]).catch(() => ({ type: "text" as const, text: "" }));
const contentArraySchema = z.array(contentPartSchema);
const toolResultSchema = z.object({ content: contentArraySchema.optional() });
const compactDividerContentSchema = z.object({ label: z.string().optional() });
const compactDividerDetailsSchema = z.object({
	summary: z.string().optional(),
	result: z.object({ summary: z.string().optional() }).optional(),
});
const transcriptMessageSchema = z.object({
	role: z.string().optional(),
	customType: z.string().optional(),
	display: z.boolean().optional(),
	timestamp: z.number().optional(),
	content: z.unknown().optional(),
});
const recordSchema = z.record(z.string(), z.unknown());

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

interface ItemRenderContext {
	theme: ReturnType<typeof createDPiNativeTheme>;
	markdownTheme: ReturnType<typeof getDPiNativeMarkdownTheme>;
	style: ReturnType<typeof createDPiInteractiveStyle>;
	options: DPiInteractiveMessageListComponentOptions;
}

interface ItemSlot {
	itemId: string;
	index: number;
	components: Component[];
	assistantComponent: DPiNativeAssistantMessageComponent | undefined;
	toolComponents: Map<string, DPiNativeToolExecutionComponent>;
}

export class DPiInteractiveMessageListRenderer {
	private readonly container: Container;
	private ctx: ItemRenderContext;
	private itemSlots: ItemSlot[] = [];
	private itemSlotById = new Map<string, ItemSlot>();
	private statusComponents: Component[] = [];
	private errorComponent: Text | undefined;
	private lastStatusEntries: readonly DPiInteractiveStatusEntry[] = [];
	private lastErrorText = "";
	private lastToolsExpanded = false;
	private lastCwd: string | undefined;

	constructor(container: Container, options: DPiInteractiveMessageListComponentOptions = {}) {
		this.container = container;
		this.ctx = createItemRenderContext(options);
		this.lastToolsExpanded = options.toolsExpanded ?? false;
		this.lastCwd = options.cwd;
	}

	updateOptions(options: DPiInteractiveMessageListComponentOptions): void {
		this.ctx = createItemRenderContext(options);
	}

	update(
		snapshot: DPiInteractiveSessionStateSnapshot,
		statusEntries: readonly DPiInteractiveStatusEntry[] = [],
		errorText = "",
	): void {
		const options = this.ctx.options;
		const newToolsExpanded = options.toolsExpanded ?? false;
		const newCwd = options.cwd;
		const optionsChanged = newCwd !== this.lastCwd;
		const toolsExpandedChanged = newToolsExpanded !== this.lastToolsExpanded;

		if (optionsChanged) {
			this.reset();
		} else if (toolsExpandedChanged) {
			for (const slot of this.itemSlots) {
				for (const [, tc] of slot.toolComponents) {
					tc.setExpanded(newToolsExpanded);
				}
			}
		}

		this.lastToolsExpanded = newToolsExpanded;
		this.lastCwd = newCwd;

		const items = getSnapshotTranscriptItems(snapshot);
		const transcriptToolCallIds = collectTranscriptToolCallIds(items);
		const showStatusEntries = items.some((item) => item.type === "turn_stats") ? [] : statusEntries;

		let rebuildFromIndex = -1;
		const newItemIds = new Set<string>();

		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			newItemIds.add(item.id);

			if (rebuildFromIndex >= 0) {
				continue;
			}

			const slot = this.itemSlotById.get(item.id);
			if (!slot) {
				rebuildFromIndex = i;
				continue;
			}

			if (slot.index !== i) {
				rebuildFromIndex = Math.min(i, slot.index);
				continue;
			}

			if (item.type === "message" && item.message.role === "assistant" && slot.assistantComponent) {
				const assistant = normalizeAssistantMessage(item.message);
				const inlineToolCalls = assistant.content
					.filter((part): part is ToolCall => part.type === "toolCall")
					.filter((toolCall) => !transcriptToolCallIds.has(toolCall.id));
				const existingIds = new Set(slot.toolComponents.keys());
				const newIds = new Set(inlineToolCalls.map((tc) => tc.id));
				const toolsChanged = existingIds.size !== newIds.size || [...newIds].some((id) => !existingIds.has(id));
				if (toolsChanged) {
					rebuildFromIndex = i;
					continue;
				}
				slot.assistantComponent.updateContent(assistant);
				for (const tc of inlineToolCalls) {
					const tc2 = slot.toolComponents.get(tc.id);
					if (tc2) {
						tc2.updateResult(findToolResult(snapshot.messages, tc.id));
					}
				}
			} else if (item.type === "tool_state") {
				const tc = slot.toolComponents.get(item.toolCallId);
				if (tc) {
					tc.updateResult(item.status === "running" ? undefined : transcriptToolResult(item));
				}
			}
		}

		for (let i = this.itemSlots.length - 1; i >= 0; i--) {
			if (!newItemIds.has(this.itemSlots[i]!.itemId)) {
				if (rebuildFromIndex < 0 || i < rebuildFromIndex) {
					rebuildFromIndex = i;
				}
			}
		}

		if (rebuildFromIndex >= 0) {
			this.rebuildFromIndex(rebuildFromIndex, items, snapshot.messages, transcriptToolCallIds);
		}

		this.syncStatusAndError(showStatusEntries, items.length, errorText);
		this.lastStatusEntries = showStatusEntries;
		this.lastErrorText = errorText;
	}

	reset(): void {
		this.disposeAllSlots();
		this.container.clear();
		this.itemSlots = [];
		this.itemSlotById.clear();
		this.statusComponents = [];
		this.errorComponent = undefined;
		this.lastStatusEntries = [];
		this.lastErrorText = "";
	}

	private rebuildFromIndex(
		fromIndex: number,
		items: readonly DPiTranscriptItem[],
		messages: readonly AgentMessage[],
		transcriptToolCallIds: ReadonlySet<string>,
	): void {
		this.removeSlotsFrom(fromIndex);
		this.removeStatusComponents();
		this.removeErrorComponent();

		for (let i = fromIndex; i < items.length; i++) {
			this.appendSlot(items[i]!, messages, transcriptToolCallIds);
		}
	}

	private disposeAllSlots(): void {
		for (const slot of this.itemSlots) {
			disposeComponents(slot.components);
		}
	}

	private removeSlotsFrom(fromIndex: number): void {
		for (let i = this.itemSlots.length - 1; i >= fromIndex; i--) {
			const slot = this.itemSlots[i]!;
			disposeComponents(slot.components);
			for (const comp of slot.components) {
				this.container.removeChild(comp);
			}
			this.itemSlotById.delete(slot.itemId);
		}
		this.itemSlots.length = fromIndex;
	}

	private appendSlot(
		item: DPiTranscriptItem,
		messages: readonly AgentMessage[],
		transcriptToolCallIds: ReadonlySet<string>,
	): void {
		const hasContentBefore = this.container.children.length > 0;
		const itemComps = buildItemComponents(item, messages, transcriptToolCallIds, this.ctx);
		const components: Component[] = [];

		if (item.type === "message" && item.message.role === "user" && itemComps.length > 0 && hasContentBefore) {
			components.push(new Spacer(1));
		}

		let assistantComponent: DPiNativeAssistantMessageComponent | undefined;
		const toolComponents = new Map<string, DPiNativeToolExecutionComponent>();
		for (const comp of itemComps) {
			components.push(comp);
			if (comp instanceof DPiNativeAssistantMessageComponent) {
				assistantComponent = comp;
			}
			if (comp instanceof DPiNativeToolExecutionComponent) {
				toolComponents.set(comp.toolCallId, comp);
			}
		}

		for (const comp of components) {
			this.container.addChild(comp);
		}

		const slot: ItemSlot = {
			itemId: item.id,
			index: this.itemSlots.length,
			components,
			assistantComponent,
			toolComponents,
		};
		this.itemSlots.push(slot);
		this.itemSlotById.set(item.id, slot);
	}

	private syncStatusAndError(
		statusEntries: readonly DPiInteractiveStatusEntry[],
		itemsLength: number,
		errorText: string,
	): void {
		const entriesChanged =
			statusEntries.length !== this.lastStatusEntries.length ||
			statusEntries.some(
				(e, i) =>
					e.afterMessageCount !== this.lastStatusEntries[i]?.afterMessageCount ||
					e.text !== this.lastStatusEntries[i]?.text,
			);
		const errorChanged = errorText !== this.lastErrorText;

		if (entriesChanged) {
			this.removeStatusComponents();
			const addEntry = (entry: DPiInteractiveStatusEntry): void => {
				const spacer = new Spacer(1);
				const text = new Text(this.ctx.style.dim(entry.text), 1, 0);
				this.container.addChild(spacer);
				this.container.addChild(text);
				this.statusComponents.push(spacer, text);
			};
			for (const entry of statusEntries) {
				if (entry.afterMessageCount > itemsLength || (itemsLength === 0 && entry.afterMessageCount === 0)) {
					addEntry(entry);
				}
			}
		}

		if (errorChanged) {
			this.removeErrorComponent();
			if (errorText) {
				this.errorComponent = new Text(errorText, 1, 0);
				this.container.addChild(this.errorComponent);
			}
		}
	}

	private removeStatusComponents(): void {
		for (const comp of this.statusComponents) {
			this.container.removeChild(comp);
		}
		this.statusComponents = [];
	}

	private removeErrorComponent(): void {
		if (this.errorComponent) {
			this.container.removeChild(this.errorComponent);
			this.errorComponent = undefined;
		}
	}
}

function createItemRenderContext(options: DPiInteractiveMessageListComponentOptions): ItemRenderContext {
	const theme = createDPiNativeTheme(options);
	return {
		theme,
		markdownTheme: getDPiNativeMarkdownTheme(theme),
		style: createDPiInteractiveStyle(options),
		options,
	};
}

function disposeComponents(components: readonly Component[]): void {
	for (const comp of components) {
		const disposable = comp as { dispose?: () => void };
		if (typeof disposable.dispose === "function") {
			disposable.dispose();
		}
	}
}

export function getSnapshotTranscriptItems(snapshot: DPiInteractiveSessionStateSnapshot): DPiTranscriptItem[] {
	return (
		snapshot.transcriptItems?.map((item) => ({ ...item })) ??
		snapshot.messages.map((message, index) => ({
			id: `message-${index}`,
			type: "message" as const,
			message,
			timestamp: transcriptMessageSchema.safeParse(message).data?.timestamp ?? Date.now(),
		}))
	);
}

function collectTranscriptToolCallIds(items: readonly DPiTranscriptItem[]): Set<string> {
	return new Set(items.flatMap((item) => (item.type === "tool_state" ? [item.toolCallId] : [])));
}

function buildItemComponents(
	item: DPiTranscriptItem,
	messages: readonly AgentMessage[],
	transcriptToolCallIds: ReadonlySet<string>,
	ctx: ItemRenderContext,
): Component[] {
	if (item.type === "message") {
		return buildMessageComponents(item.message, messages, transcriptToolCallIds, ctx);
	}
	if (item.type === "boundary") {
		const details: Record<string, unknown> = {};
		if (item.summary !== undefined) details.summary = item.summary;
		if (item.tokensBefore !== undefined) details.tokensBefore = item.tokensBefore;
		if (item.durationMs !== undefined) details.durationMs = item.durationMs;
		if (item.completedAt !== undefined) details.completedAt = item.completedAt;
		return buildMessageComponents(
			{
				role: "custom",
				customType: "compact-divider",
				content: item.label,
				display: true,
				details,
				timestamp: item.timestamp,
			},
			messages,
			transcriptToolCallIds,
			ctx,
		);
	}
	if (item.type === "tool_state") {
		return [
			new DPiNativeToolExecutionComponent(
				{ type: "toolCall", id: item.toolCallId, name: item.toolName, arguments: recordArgs(item.args) },
				transcriptToolResult(item),
				{
					theme: ctx.theme,
					cwd: ctx.options.cwd,
					expanded: ctx.options.toolsExpanded,
					showImages: ctx.options.showImages,
					imageWidthCells: ctx.options.imageWidthCells,
				},
			),
		];
	}
	if (item.type === "turn_stats") {
		return [
			new Spacer(1),
			new Text(
				ctx.theme.fg("muted", buildDPiInteractiveStatusView({ isStreaming: false }, item, { color: false }).text),
				1,
				0,
			),
		];
	}
	return [new Spacer(1), new Text(ctx.theme.fg(item.level === "error" ? "error" : "muted", item.text), 1, 0)];
}

function buildMessageComponents(
	message: AgentMessage,
	messages: readonly AgentMessage[],
	transcriptToolCallIds: ReadonlySet<string>,
	ctx: ItemRenderContext,
): Component[] {
	const custom = buildCustomMessageComponent(message, ctx);
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
				theme: ctx.theme,
				markdownTheme: ctx.markdownTheme,
			}),
		];
	}
	if (isCompactDividerMessage(message)) {
		const divider = new Container();
		const summary = compactDividerSummary(message);
		divider.addChild(new Spacer(1));
		divider.addChild(new DPiNativeDynamicBorder((text) => ctx.theme.fg("borderMuted", text)));
		divider.addChild(new Text(ctx.theme.fg("muted", compactDividerLabel(message)), 1, 0));
		divider.addChild(new Spacer(1));
		if (summary) {
			divider.addChild(
				new Markdown(summary, 1, 0, ctx.markdownTheme, {
					color: (text: string) => ctx.theme.fg("muted", text),
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
		return text ? [new Text(ctx.theme.fg("muted", text), 1, 0)] : [];
	}
	const assistant = normalizeAssistantMessage(message);
	const assistantComp = new DPiNativeAssistantMessageComponent(assistant, {
		theme: ctx.theme,
		markdownTheme: ctx.markdownTheme,
	});
	const toolComps = assistant.content
		.filter((part): part is ToolCall => part.type === "toolCall")
		.filter((toolCall) => !transcriptToolCallIds.has(toolCall.id))
		.map(
			(toolCall) =>
				new DPiNativeToolExecutionComponent(toolCall, findToolResult(messages, toolCall.id), {
					theme: ctx.theme,
					cwd: ctx.options.cwd,
					expanded: ctx.options.toolsExpanded,
					showImages: ctx.options.showImages,
					imageWidthCells: ctx.options.imageWidthCells,
				}),
		);
	return [assistantComp, ...toolComps];
}

function buildCustomMessageComponent(message: AgentMessage, ctx: ItemRenderContext): Component | undefined {
	const customType = messageCustomType(message);
	if (!customType) {
		return undefined;
	}
	if (customType === "d-pi-message") {
		return renderDPiMetaMessage(message, ctx);
	}
	return undefined;
}

export function buildDPiInteractiveMessageListView(
	snapshot: DPiInteractiveSessionStateSnapshot,
	options: DPiInteractiveStyleOptions = {},
): DPiInteractiveMessageListView {
	const lines = [
		...getSnapshotTranscriptItems(snapshot).flatMap((item) => itemLines(item, options)),
		...snapshot.steeringMessages.map((message) => createDPiInteractiveStyle(options).dim(`steer queued: ${message}`)),
	];
	return { text: lines.join("\n") };
}

export function buildDPiInteractiveMessageListComponent(
	snapshot: DPiInteractiveSessionStateSnapshot,
	options: DPiInteractiveMessageListComponentOptions = {},
): Container {
	const container = new Container();
	const ctx = createItemRenderContext(options);
	const items = getSnapshotTranscriptItems(snapshot);
	const transcriptToolCallIds = collectTranscriptToolCallIds(items);
	const statusEntries = items.some((item) => item.type === "turn_stats") ? [] : (options.statusEntries ?? []);
	const addStatusEntry = (entry: DPiInteractiveStatusEntry): void => {
		container.addChild(new Spacer(1));
		container.addChild(new Text(ctx.style.dim(entry.text), 1, 0));
	};
	for (const [index, item] of items.entries()) {
		const components = buildItemComponents(item, snapshot.messages, transcriptToolCallIds, ctx);
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
		const details: Record<string, unknown> = {};
		if (item.summary !== undefined) details.summary = item.summary;
		if (item.tokensBefore !== undefined) details.tokensBefore = item.tokensBefore;
		return messageLines(
			{
				role: "custom",
				customType: "compact-divider",
				content: item.label,
				display: true,
				details,
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
	return ["", ...blockLines(item.text, item.level === "error" ? style.error : style.muted)];
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

function messageCustomType(message: AgentMessage): string | undefined {
	if ("customType" in message && typeof message.customType === "string") {
		return message.customType;
	}
	return "content" in message && extractDPiMeta(message.content) ? "d-pi-message" : undefined;
}

function renderDPiMetaMessage(message: AgentMessage, ctx: ItemRenderContext): Component | undefined {
	const extracted = "content" in message ? extractDPiMeta(message.content) : undefined;
	const meta = extracted?.meta ?? parseMessageDetailsMeta(message);
	if (!meta) return undefined;
	const sourceName = meta.agentName ?? meta.sourceName ?? meta.connectId ?? "";
	const authName = meta.auth?.name ?? "";
	const source = sourceName ? `${meta.sourceType}:${sourceName}` : meta.sourceType;
	const header = [source, authName, meta.createTime].filter((part) => part.trim()).join(" · ");
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Text(ctx.theme.fg("warning", header), 0, 0));
	const text = extracted?.text ?? ("content" in message ? contentText(message.content) : "");
	if (text) {
		const box = new Box(1, 1, (text: string) => ctx.theme.bg("userMessageBg", text));
		box.addChild(
			new Markdown(
				text,
				0,
				0,
				{
					heading: (text) => text,
					link: (text) => text,
					linkUrl: (text) => text,
					code: (text) => text,
					codeBlock: (text) => text,
					codeBlockBorder: (text) => text,
					quote: (text) => text,
					quoteBorder: (text) => text,
					hr: (text) => text,
					listBullet: (text) => text,
					bold: (text) => text,
					italic: (text) => text,
					strikethrough: (text) => text,
					underline: (text) => text,
				},
				{
					color: (text: string) => ctx.theme.fg("userMessageText", text),
				},
			),
		);
		container.addChild(box);
	}
	return container;
}

function parseMessageDetailsMeta(message: AgentMessage) {
	if (!("details" in message)) return undefined;
	const parsed = dPiMessageMetaSchema.safeParse(message.details);
	return parsed.success ? parsed.data : undefined;
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
	const parsed = recordSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}

function transcriptToolResultContent(
	item: Extract<DPiTranscriptItem, { type: "tool_state" }>,
): ToolResultMessage["content"] {
	const parsed = toolResultSchema.safeParse(item.result);
	if (parsed.success && parsed.data.content) {
		return parsed.data.content;
	}
	return [{ type: "text", text: transcriptToolText(item) }];
}

function transcriptToolText(item: Extract<DPiTranscriptItem, { type: "tool_state" }>): string {
	if (item.error) {
		return item.error;
	}
	if (typeof item.result === "string") {
		return item.result;
	}
	const text = extractContentText(item.result);
	if (text) {
		return text;
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
	return extractContentText(content);
}

function extractContentText(value: unknown): string {
	const parsed = contentArraySchema.safeParse(value);
	if (!parsed.success) {
		return "";
	}
	return parsed.data
		.filter((p): p is z.infer<typeof textPartSchema> => p.type === "text")
		.map((p) => p.text)
		.join("");
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
	return compactDividerContentSchema.safeParse(content).data?.label ?? "Compact completed";
}

function compactDividerSummary(message: AgentMessage): string | undefined {
	if (!("details" in message)) {
		return undefined;
	}
	const details = compactDividerDetailsSchema.safeParse(message.details).data;
	if (details?.summary?.trim()) {
		return details.summary;
	}
	if (details?.result?.summary?.trim()) {
		return details.result.summary;
	}
	return undefined;
}
