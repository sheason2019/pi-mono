import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { createDPiNativeTheme, type DPiNativeTheme, getDPiNativeMarkdownTheme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface DPiNativeAssistantMessageComponentOptions {
	theme?: DPiNativeTheme;
	markdownTheme?: MarkdownTheme;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
}

export class DPiNativeAssistantMessageComponent extends Container {
	private readonly contentContainer: Container;
	private readonly theme: DPiNativeTheme;
	private readonly markdownTheme: MarkdownTheme;
	private hideThinkingBlock: boolean;
	private hiddenThinkingLabel: string;
	private lastMessage: AssistantMessage | undefined;
	private hasToolCalls = false;

	constructor(message?: AssistantMessage, options: DPiNativeAssistantMessageComponentOptions = {}) {
		super();
		this.theme = options.theme ?? createDPiNativeTheme();
		this.markdownTheme = options.markdownTheme ?? getDPiNativeMarkdownTheme(this.theme);
		this.hideThinkingBlock = options.hideThinkingBlock ?? false;
		this.hiddenThinkingLabel = options.hiddenThinkingLabel ?? "Thinking...";
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(content) =>
				(content.type === "text" && content.text.trim()) ||
				(content.type === "thinking" && content.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(nextContent) =>
							(nextContent.type === "text" && nextContent.text.trim()) ||
							(nextContent.type === "thinking" && nextContent.thinking.trim()),
					);
				if (this.hideThinkingBlock) {
					this.contentContainer.addChild(
						new Text(this.theme.italic(this.theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
				} else {
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text) => this.theme.fg("thinkingText", text),
							italic: true,
						}),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls && message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(this.theme.fg("error", abortMessage), 1, 0));
		} else if (!hasToolCalls && message.stopReason === "error") {
			const errorMessage = message.errorMessage || "Unknown error";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(this.theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		}
	}
}
