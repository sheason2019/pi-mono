import { UserMessageComponent as BaseUserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

export { KeybindingsManager } from "../keybindings.js";

import { getEditorTheme, theme } from "../../../../../coding-agent/src/modes/interactive/theme/theme.js";

export { getEditorTheme, theme };

import { formatMessageSourceLabel, type MessageSource } from "../../../hub/agent/types.js";

export {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	initTheme,
	ToolExecutionComponent,
	type ToolExecutionOptions,
} from "@earendil-works/pi-coding-agent";

export class UserMessageComponent extends BaseUserMessageComponent {
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
