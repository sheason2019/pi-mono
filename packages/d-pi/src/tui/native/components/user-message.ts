import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createDPiNativeTheme, type DPiNativeTheme, getDPiNativeMarkdownTheme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface DPiNativeUserMessageComponentOptions {
	theme?: DPiNativeTheme;
	markdownTheme?: MarkdownTheme;
}

export class DPiNativeUserMessageComponent extends Container {
	private readonly contentBox: Box;

	constructor(text: string, options: DPiNativeUserMessageComponentOptions = {}) {
		super();
		const theme = options.theme ?? createDPiNativeTheme();
		const markdownTheme = options.markdownTheme ?? getDPiNativeMarkdownTheme(theme);
		this.contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
		this.contentBox.addChild(
			new Markdown(text, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("userMessageText", content),
			}),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
