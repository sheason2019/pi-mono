import { type Component, type Focusable, SelectList, truncateToWidth } from "@sheason/pi-tui";
import type { McpRuntimeStatus } from "../../../../hub/index.js";
import { theme } from "../../components/index.js";
import { getForkedSelectListTheme, renderForkedPanelBorder } from "./selector-themes.js";

export type McpDetailAction = "pause" | "restart" | "remove";
type McpDetailListAction = McpDetailAction | "view_error";

const STATUS_COLOR: Record<McpRuntimeStatus["status"], "success" | "warning" | "error" | "muted"> = {
	running: "success",
	starting: "warning",
	stopped: "muted",
	error: "error",
};

const ACTION_ITEMS: { value: McpDetailAction; label: string; description: string }[] = [
	{ value: "pause", label: "Pause", description: "Stop the MCP client and mark it disabled in .pi/mcp.json" },
	{ value: "restart", label: "Restart", description: "Re-enable the server and (re)connect" },
	{ value: "remove", label: "Remove", description: "Delete the entry from .pi/mcp.json" },
];

function actionItemsForServer(
	server: McpRuntimeStatus,
): { value: McpDetailListAction; label: string; description: string }[] {
	const items: { value: McpDetailListAction; label: string; description: string }[] = [];
	if (server.error) {
		items.push({ value: "view_error", label: "View Error", description: "Show the full MCP startup error" });
	}
	items.push(...ACTION_ITEMS);
	return items;
}

export class RemoteMcpDetailSelectorComponent implements Component, Focusable {
	private readonly selectList: SelectList;
	private viewingError = false;
	focused = false;

	constructor(
		private readonly server: McpRuntimeStatus,
		private readonly onAction: (action: McpDetailAction) => void,
		private readonly onCancelSelection: () => void,
	) {
		const actionItems = actionItemsForServer(this.server);
		this.selectList = new SelectList(
			actionItems.map((item) => ({ value: item.value, label: item.label, description: item.description })),
			actionItems.length,
			getForkedSelectListTheme(),
			{ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 20 },
		);
		this.selectList.onSelect = (item) => {
			if (item.value === "view_error") {
				this.viewingError = true;
				return;
			}
			this.onAction(item.value as McpDetailAction);
		};
		this.selectList.onCancel = () => {
			if (this.viewingError) {
				this.viewingError = false;
				return;
			}
			this.onCancelSelection();
		};
	}

	getFocusTarget(): Component {
		return this.selectList;
	}

	render(width: number): string[] {
		if (this.viewingError && this.server.error) {
			return renderErrorView(this.server, width);
		}
		const statusColor = STATUS_COLOR[this.server.status];
		const paused = this.server.disabled === true;
		const title =
			theme.bold(theme.fg("accent", `MCP: ${this.server.name}`)) + (paused ? theme.fg("muted", " (paused)") : "");
		const lines = [
			renderForkedPanelBorder(width),
			"",
			title,
			theme.fg("muted", `Transport: ${this.server.transport}  Status: ${theme.fg(statusColor, this.server.status)}`),
		];
		lines.push("");

		if (paused) {
			lines.push(theme.fg("muted", "Capabilities: (paused — capabilities not loaded)"));
			lines.push("");
		} else {
			const { tools, resources, prompts } = this.server.capabilities;
			if (tools.length > 0) {
				lines.push(theme.bold(theme.fg("accent", `Tools (${tools.length})`)));
				for (const t of tools) {
					const desc = t.description?.trim() ? t.description : "";
					const rest = desc.length > 0 ? `: ${desc}` : "";
					lines.push(theme.fg("muted", `  * ${t.name}${rest}`));
				}
				lines.push("");
			}
			if (resources.length > 0) {
				lines.push(theme.bold(theme.fg("accent", `Resources (${resources.length})`)));
				for (const r of resources) {
					let rest = `  * ${r.uri}`;
					if (r.mimeType?.trim()) {
						rest += ` [${r.mimeType}]`;
					}
					if (r.name?.trim()) {
						rest += ` (${r.name})`;
					}
					const d = r.description?.trim() ? r.description : "";
					if (d.length > 0) {
						rest += `: ${d}`;
					}
					lines.push(theme.fg("muted", rest));
				}
				lines.push("");
			}
			if (prompts.length > 0) {
				lines.push(theme.bold(theme.fg("accent", `Prompts (${prompts.length})`)));
				for (const p of prompts) {
					const desc = p.description?.trim() ? p.description : "";
					const pRest = desc.length > 0 ? `: ${desc}` : "";
					lines.push(theme.fg("muted", `  * ${p.name}${pRest}`));
				}
				lines.push("");
			}
		}

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

function renderErrorView(server: McpRuntimeStatus, width: number): string[] {
	const bodyWidth = Math.max(1, width - 4);
	const lines = [renderForkedPanelBorder(width), "", theme.bold(theme.fg("accent", `MCP Error: ${server.name}`)), ""];
	for (const line of wrapPlainText(server.error ?? "", bodyWidth)) {
		lines.push(theme.fg("error", line));
	}
	lines.push("", theme.fg("dim", "  Esc to go back"), "", renderForkedPanelBorder(width));
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function wrapPlainText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		if (rawLine.length === 0) {
			out.push("");
			continue;
		}
		for (let i = 0; i < rawLine.length; i += width) {
			out.push(rawLine.slice(i, i + width));
		}
	}
	return out.length > 0 ? out : [""];
}
