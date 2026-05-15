import { type Component, type Focusable, SelectList, truncateToWidth } from "@sheason/pi-tui";
import type { SourceRuntimeStatus, SourceRuntimeStatusKind } from "../../../../hub/index.js";
import { theme } from "../../components/index.js";
import { getForkedSelectListTheme, renderForkedPanelBorder } from "./selector-themes.js";

export type SourceDetailAction = "pause" | "restart" | "remove";

const STATUS_COLOR: Record<SourceRuntimeStatusKind, "success" | "warning" | "error" | "muted"> = {
	running: "success",
	starting: "warning",
	stopped: "muted",
	error: "error",
};

const ACTION_ITEMS: { value: SourceDetailAction; label: string; description: string }[] = [
	{
		value: "pause",
		label: "Pause",
		description: "Stop the source process and mark it disabled in the source config file",
	},
	{ value: "restart", label: "Restart", description: "Re-enable the source and (re)spawn the process" },
	{ value: "remove", label: "Remove", description: "Delete the entry from the source config file" },
];

function actionItemsForSource(
	source: SourceRuntimeStatus,
): { value: SourceDetailAction; label: string; description: string }[] {
	const items: { value: SourceDetailAction; label: string; description: string }[] = [];
	if (source.status === "running" || source.status === "starting") {
		items.push(ACTION_ITEMS[0]!);
	} else {
		items.push(ACTION_ITEMS[1]!);
	}
	items.push(ACTION_ITEMS[2]!);
	return items;
}

export class RemoteSourceDetailSelectorComponent implements Component, Focusable {
	private readonly selectList: SelectList;
	focused = false;

	constructor(
		private readonly source: SourceRuntimeStatus,
		private readonly onAction: (action: SourceDetailAction) => void,
		private readonly onCancelSelection: () => void,
	) {
		const actionItems = actionItemsForSource(this.source);
		this.selectList = new SelectList(
			actionItems.map((item) => ({ value: item.value, label: item.label, description: item.description })),
			actionItems.length,
			getForkedSelectListTheme(),
			{ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 20 },
		);
		this.selectList.onSelect = (item) => {
			this.onAction(item.value as SourceDetailAction);
		};
		this.selectList.onCancel = () => this.onCancelSelection();
	}

	getFocusTarget(): Component {
		return this.selectList;
	}

	render(width: number): string[] {
		const statusColor = STATUS_COLOR[this.source.status];
		const origin = this.source.origin === "peer" ? `peer (${this.source.peerId ?? "unknown"})` : "hub";
		const lines = [
			renderForkedPanelBorder(width),
			"",
			theme.bold(theme.fg("accent", `Source: ${this.source.name}`)),
			theme.fg(
				"muted",
				`Origin: ${origin}  Transport: ${this.source.transport}  Status: ${theme.fg(statusColor, this.source.status)}`,
			),
			theme.fg(
				"muted",
				this.source.origin === "peer"
					? "Config: peer source config (agent, global, or workspace)"
					: "Config: hub workspace .pi/sources.json",
			),
		];
		if (this.source.error) {
			lines.push(theme.fg("error", `Error: ${this.source.error}`));
		}
		lines.push("");
		lines.push(...this.selectList.render(width));
		lines.push("");
		lines.push(theme.fg("dim", "  Enter to run · Esc to go back"));
		lines.push("");
		lines.push(renderForkedPanelBorder(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		this.selectList.invalidate();
	}
}
