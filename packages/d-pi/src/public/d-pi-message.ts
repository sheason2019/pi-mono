import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { dPiMessageMetaSchema, extractDPiMeta } from "../message-meta.ts";
import { defineTuiComponent } from "../tui-components/tui-component-definition.ts";

export default defineTuiComponent({
	customType: "d-pi-message",
	render: (message, _options, theme) => {
		const extracted = extractDPiMeta(message.content);
		const meta = extracted?.meta ?? parseMessageMeta(message.details);
		if (!meta) return undefined;
		const sourceName = meta.agentName ?? meta.sourceName ?? meta.connectId ?? "";
		const authName = meta.auth?.name ?? "";
		const source = sourceName ? `${meta.sourceType}:${sourceName}` : meta.sourceType;
		const header = [source, authName, meta.createTime].filter((part) => part.trim()).join(" · ");
		const container = new Container();
		container.addChild(new Spacer(1));
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

function parseMessageMeta(value: unknown) {
	const parsed = dPiMessageMetaSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
