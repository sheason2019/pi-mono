import type { MarkdownTheme } from "@earendil-works/pi-tui";
import * as PiCodingAgent from "@sheason/pi-coding-agent";

export { KeybindingsManager } from "../keybindings.js";

export const getEditorTheme = PiCodingAgent.getEditorTheme;
export const theme = PiCodingAgent.theme;

import { formatMessageSourceLabel, type MessageSource } from "../../../hub/agent/types.js";

export {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	initTheme,
	ToolExecutionComponent,
	type ToolExecutionOptions,
} from "@sheason/pi-coding-agent";

export class UserMessageComponent extends PiCodingAgent.UserMessageComponent {
	private readonly messageSource?: MessageSource;

	constructor(text: string, markdownTheme?: MarkdownTheme, messageSource?: MessageSource) {
		super(text, markdownTheme);
		this.messageSource = messageSource;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.messageSource) {
			return lines;
		}
		return [theme.fg("warning", formatMessageSourceLabel(this.messageSource)), ...lines];
	}
}
