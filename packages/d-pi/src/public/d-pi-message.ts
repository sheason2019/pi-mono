import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { type DPiMessageMeta, extractDPiMeta } from "../message-meta.ts";
import { defineTuiComponent } from "../tui-components/tui-component-definition.ts";

export default defineTuiComponent({
	customType: "d-pi-message",
	render: (message, _options, theme) => {
		const extracted = extractDPiMeta(message.content);
		const meta = extracted?.meta ?? detailsMeta(message.details);
		if (!meta) return undefined;
		const sourceType = typeof meta.sourceType === "string" ? meta.sourceType : "unknown";
		const sourceName =
			typeof meta.agentName === "string"
				? meta.agentName
				: typeof meta.sourceName === "string"
					? meta.sourceName
					: typeof meta.connectId === "string"
						? meta.connectId
						: "";
		const createTime = typeof meta.createTime === "string" ? meta.createTime : "";
		const authName =
			typeof meta.auth === "object" &&
			meta.auth !== null &&
			"name" in meta.auth &&
			typeof meta.auth.name === "string"
				? meta.auth.name
				: "";
		const source = sourceName ? `${sourceType}:${sourceName}` : sourceType;
		const header = [source, authName, createTime].filter((part) => part.trim()).join(" · ");
		const container = new Container();
		container.addChild(new Text(theme.fg("warning", header), 0, 0));
		const text = extracted?.text ?? "";
		if (text) {
			const box = new Box(1, 1, (text: string) => theme.bg("userMessageBg", text));
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
						color: (text: string) => theme.fg("userMessageText", text),
					},
				),
			);
			container.addChild(box);
		}
		return container;
	},
});

function detailsMeta(value: unknown): DPiMessageMeta | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const sourceType = record.sourceType;
	if (sourceType !== "agent" && sourceType !== "connect" && sourceType !== "source") {
		return undefined;
	}
	return record as unknown as DPiMessageMeta;
}
