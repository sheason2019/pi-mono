import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { extractDPiMeta } from "../message-meta.ts";
import { defineTuiComponent } from "../tui-components/tui-component-definition.ts";

export default defineTuiComponent({
	customType: "d-pi-message",
	render: (message, _options, theme) => {
		const extracted = extractDPiMeta(message.content);
		const meta = extracted?.meta;
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
		const container = new Container();
		container.addChild(
			new Text(theme.fg("customMessageLabel", sourceName ? `${sourceType}: ${sourceName}` : sourceType), 1, 0),
		);
		if (extracted.text) {
			const box = new Box(1, 1, (text: string) => theme.bg("userMessageBg", text));
			box.addChild(
				new Markdown(
					extracted.text,
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
