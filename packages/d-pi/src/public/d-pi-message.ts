import { Container, Text } from "@earendil-works/pi-tui";
import { extractDPiMeta } from "../message-meta.ts";
import { defineTuiComponent } from "../tui-components/tui-component-definition.ts";

export default defineTuiComponent({
	customType: "d-pi-message",
	render: (message, _options, theme) => {
		const meta = extractDPiMeta(message.content)?.meta;
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
		return container;
	},
});
