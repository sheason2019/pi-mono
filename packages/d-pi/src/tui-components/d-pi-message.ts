import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@sheason/pi-coding-agent";
import { defineTuiComponent } from "../agent-definition.ts";
import type { MessageMeta } from "../extension/message-meta.ts";
import { extractMeta } from "../extension/message-meta.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function messageContentToText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n");
}

export const dPiMessageTuiComponent = defineTuiComponent<MessageMeta>({
	customType: "d-pi-message",
	render(message, _options, theme) {
		const rawText = messageContentToText(message.content);
		const extracted = extractMeta(rawText);
		const meta = extracted?.meta ?? message.details;
		if (!meta) {
			return undefined;
		}
		const textContent = extracted?.text ?? rawText;

		let source: string = meta.sourceType;
		if (meta.sourceType === "connect" && meta.connectId) {
			source = `${source} ${meta.connectId}`;
		} else if (meta.sourceName) {
			source = `${source}:${meta.sourceName}`;
		} else if (meta.agentName) {
			source = `${source}:${meta.agentName}`;
		}
		const headerParts = [source, meta.auth?.name, meta.createTime].filter((part) => part?.trim());

		const container = new Container();
		container.addChild(new Text(theme.fg("warning", headerParts.join(" · ")), 0, 0));
		if (textContent) {
			const box = new Box(1, 1, (t: string) => theme.bg("userMessageBg", t));
			box.addChild(
				new Markdown(textContent, 0, 0, getMarkdownTheme(), {
					color: (t: string) => theme.fg("userMessageText", t),
				}),
			);
			container.addChild(box);
		}
		return container;
	},
});
