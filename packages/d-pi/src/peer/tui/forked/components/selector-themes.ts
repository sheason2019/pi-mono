import type { SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";
import { theme } from "../../components/index.js";

export function getForkedSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getForkedSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}

export function renderForkedPanelBorder(width: number): string {
	return theme.fg("border", "─".repeat(Math.max(1, width)));
}
