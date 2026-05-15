import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@sheason/pi-tui";
import type { HubSkillDiagnostic, HubSkillInfo } from "../../../../hub/index.js";
import { theme } from "../../components/index.js";
import { renderForkedPanelBorder } from "./selector-themes.js";

export class RemoteSkillListSelectorComponent implements Component, Focusable {
	private selectedIndex = 0;
	focused = false;

	constructor(
		private readonly skills: HubSkillInfo[],
		private readonly diagnostics: HubSkillDiagnostic[],
		private readonly onSelectSkill: (skill: HubSkillInfo) => void,
		private readonly onCancelSelection: () => void,
	) {}

	getFocusTarget(): Component {
		return this;
	}

	render(width: number): string[] {
		const lines = [renderForkedPanelBorder(width), ""];

		lines.push(theme.bold(theme.fg("accent", "Skills")), theme.fg("muted", "Select a skill to inspect."), "");

		if (this.diagnostics.length > 0) {
			lines.push(theme.bold(theme.fg("warning", `Diagnostics (${this.diagnostics.length})`)));
			for (const diagnostic of this.diagnostics.slice(0, 3)) {
				lines.push(theme.fg("warning", `  * ${diagnostic.message}`));
			}
			if (this.diagnostics.length > 3) {
				lines.push(theme.fg("muted", `  ... ${this.diagnostics.length - 3} more`));
			}
			lines.push("");
		}

		if (this.skills.length === 0) {
			lines.push(theme.fg("muted", "  No skills are available."));
			lines.push("");
			lines.push(theme.fg("dim", "  Esc to close"));
			lines.push("");
			lines.push(renderForkedPanelBorder(width));
			return lines.map((line) => truncateToWidth(line, width, ""));
		}

		const nameColumnWidth = computeNameColumnWidth(this.skills, width);
		for (let i = 0; i < this.skills.length; i += 1) {
			const skill = this.skills[i];
			if (!skill) {
				continue;
			}
			lines.push(renderRow(skill, i === this.selectedIndex, nameColumnWidth, width));
		}

		lines.push("");
		lines.push(theme.fg("dim", "  Enter to inspect · Esc to close"));
		lines.push("");
		lines.push(renderForkedPanelBorder(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.skills.length === 0) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.onCancelSelection();
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.skills.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.skills.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.skills[this.selectedIndex];
			if (selected) {
				this.onSelectSkill(selected);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelSelection();
		}
	}

	invalidate(): void {}
}

function renderRow(skill: HubSkillInfo, isSelected: boolean, nameColumnWidth: number, rowWidth: number): string {
	const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
	const namePadded = padEndVisible(skill.name, nameColumnWidth);
	const name = isSelected ? theme.fg("accent", namePadded) : namePadded;
	const source = sourceLabel(skill);
	const invocation = skill.disableModelInvocation ? theme.fg("muted", "manual") : theme.fg("success", "model");
	const left = `${prefix}${name}  ${theme.fg("muted", `[${source}]`)} ${invocation}`;
	const gap = 1;
	const maxDescription = Math.max(0, rowWidth - visibleWidth(left) - gap);
	if (maxDescription === 0) {
		return left;
	}
	const description = truncateToWidth(skill.description.trim(), maxDescription, "");
	return description.length > 0 ? `${left} ${theme.fg("muted", description)}` : left;
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

function computeNameColumnWidth(skills: HubSkillInfo[], width: number): number {
	let max = 4;
	for (const skill of skills) {
		const w = visibleWidth(skill.name);
		if (w > max) {
			max = w;
		}
	}
	const cap = Math.max(8, width - 56);
	return Math.min(max, 38, cap);
}

function padEndVisible(text: string, columnWidth: number): string {
	const w = visibleWidth(text);
	if (w >= columnWidth) {
		return text;
	}
	return `${text}${" ".repeat(columnWidth - w)}`;
}
