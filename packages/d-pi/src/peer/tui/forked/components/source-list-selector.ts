import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SourceRuntimeStatus, SourceRuntimeStatusKind } from "../../../../hub/index.js";
import { theme } from "../../components/index.js";
import { renderForkedPanelBorder } from "./selector-themes.js";

const STATUS_COLOR: Record<SourceRuntimeStatusKind, "success" | "warning" | "error" | "muted"> = {
	running: "success",
	starting: "warning",
	stopped: "muted",
	error: "error",
};

export class RemoteSourceListSelectorComponent implements Component, Focusable {
	private selectedIndex = 0;
	focused = false;

	constructor(
		private readonly sources: SourceRuntimeStatus[],
		private readonly onSelectSource: (source: SourceRuntimeStatus) => void,
		private readonly onCancelSelection: () => void,
	) {
		if (this.sources.length === 0) {
			this.selectedIndex = 0;
		}
	}

	getFocusTarget(): Component {
		return this;
	}

	render(width: number): string[] {
		const lines = [
			renderForkedPanelBorder(width),
			"",
			theme.bold(theme.fg("accent", "Hub and Peer Sources")),
			theme.fg("muted", "Select a source to inspect or manage."),
			"",
		];

		if (this.sources.length === 0) {
			lines.push(theme.fg("muted", "  No sources are configured."));
			lines.push("");
			lines.push(theme.fg("dim", "  Esc to close"));
			lines.push("");
			lines.push(renderForkedPanelBorder(width));
			return lines.map((line) => truncateToWidth(line, width, ""));
		}

		const nameColumnWidth = computeNameColumnWidth(this.sources);
		for (let i = 0; i < this.sources.length; i += 1) {
			const source = this.sources[i];
			if (!source) {
				continue;
			}
			const isSelected = i === this.selectedIndex;
			lines.push(this.renderRow(source, isSelected, nameColumnWidth));
			if (source.error) {
				const padding = " ".repeat(2 + 2 + nameColumnWidth + 2);
				lines.push(theme.fg("muted", `${padding}error: ${source.error}`));
			}
		}

		lines.push("");
		lines.push(theme.fg("dim", "  Enter to inspect · Esc to close"));
		lines.push("");
		lines.push(renderForkedPanelBorder(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.sources.length === 0) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.onCancelSelection();
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.sources.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.sources.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.sources[this.selectedIndex];
			if (selected) {
				this.onSelectSource(selected);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelSelection();
		}
	}

	invalidate(): void {}

	private renderRow(source: SourceRuntimeStatus, isSelected: boolean, nameColumnWidth: number): string {
		const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
		const namePadded = padEndVisible(source.name, nameColumnWidth);
		const name = isSelected ? theme.fg("accent", namePadded) : namePadded;
		const transport = theme.fg("muted", `[${source.transport}]`);
		const origin = theme.fg("muted", source.origin === "peer" ? "[peer]" : "[hub]");
		const statusColor = STATUS_COLOR[source.status];
		const status = theme.fg(statusColor, source.status);
		return `${prefix}${name}  ${origin} ${transport} ${status}`;
	}
}

function computeNameColumnWidth(sources: SourceRuntimeStatus[]): number {
	let max = 4;
	for (const source of sources) {
		const w = visibleWidth(source.name);
		if (w > max) {
			max = w;
		}
	}
	return Math.min(max, 32);
}

function padEndVisible(text: string, columnWidth: number): string {
	const w = visibleWidth(text);
	if (w >= columnWidth) {
		return text;
	}
	return `${text}${" ".repeat(columnWidth - w)}`;
}
