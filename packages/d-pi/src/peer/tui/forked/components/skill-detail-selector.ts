import { basename, dirname } from "node:path";
import { type Component, type Focusable, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { HubSkillInfo } from "../../../../hub/index.js";
import { theme } from "../../components/index.js";
import { renderForkedPanelBorder } from "./selector-themes.js";

export class RemoteSkillDetailSelectorComponent implements Component, Focusable {
	focused = false;

	constructor(
		private readonly skill: HubSkillInfo,
		private readonly onCancelSelection: () => void,
	) {}

	getFocusTarget(): Component {
		return this;
	}

	render(width: number): string[] {
		const lines = [
			renderForkedPanelBorder(width),
			"",
			theme.bold(theme.fg("accent", `Skill: ${this.skill.name}`)),
			theme.fg("muted", `Source: ${sourceLabel(this.skill)}  File: ${this.skill.filePath}`),
			theme.fg(
				"muted",
				`Invocation: ${this.skill.disableModelInvocation ? "manual-only" : "model and manual"}  Folder: ${basename(
					dirname(this.skill.filePath),
				)}`,
			),
			"",
			theme.bold(theme.fg("accent", "Description")),
		];

		const description = this.skill.description.trim();
		if (description.length === 0) {
			lines.push(theme.fg("muted", "  (empty)"));
		} else {
			for (const line of description.split(/\r?\n/)) {
				lines.push(theme.fg("muted", `  ${line}`));
			}
		}

		const sourceInfo = stringifySourceInfo(this.skill.sourceInfo);
		if (sourceInfo.length > 0) {
			lines.push("", theme.bold(theme.fg("accent", "Source Info")));
			for (const line of sourceInfo.split(/\r?\n/)) {
				lines.push(theme.fg("muted", `  ${line}`));
			}
		}

		lines.push("", theme.fg("dim", "  Esc to go back"), "", renderForkedPanelBorder(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.onCancelSelection();
		}
	}

	invalidate(): void {}
}

function sourceLabel(skill: HubSkillInfo): string {
	const sourceInfo = skill.sourceInfo;
	if (
		sourceInfo &&
		typeof sourceInfo === "object" &&
		"source" in sourceInfo &&
		typeof sourceInfo.source === "string"
	) {
		return sourceInfo.source;
	}
	return "local";
}

function stringifySourceInfo(sourceInfo: unknown): string {
	if (sourceInfo === undefined) {
		return "";
	}
	if (typeof sourceInfo === "string") {
		return sourceInfo;
	}
	try {
		return JSON.stringify(sourceInfo, null, 2);
	} catch {
		return String(sourceInfo);
	}
}
