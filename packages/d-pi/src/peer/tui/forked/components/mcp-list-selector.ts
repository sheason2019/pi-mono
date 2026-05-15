import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@sheason/pi-tui";
import type { McpRuntimeStatus } from "../../../../hub/index.js";
import { theme } from "../../components/index.js";
import { renderForkedPanelBorder } from "./selector-themes.js";

const STATUS_COLOR: Record<McpRuntimeStatus["status"], "success" | "warning" | "error" | "muted"> = {
	running: "success",
	starting: "warning",
	stopped: "muted",
	error: "error",
};

export class RemoteMcpListSelectorComponent implements Component, Focusable {
	private selectedIndex = 0;
	focused = false;

	constructor(
		private readonly servers: McpRuntimeStatus[],
		private readonly configError: string | undefined,
		private readonly onSelectServer: (server: McpRuntimeStatus) => void,
		private readonly onCancelSelection: () => void,
	) {
		if (this.servers.length === 0) {
			this.selectedIndex = 0;
		}
	}

	getFocusTarget(): Component {
		return this;
	}

	render(width: number): string[] {
		const lines = [renderForkedPanelBorder(width), ""];

		if (this.configError) {
			lines.push(theme.fg("warning", this.configError));
			lines.push("");
		}

		lines.push(
			theme.bold(theme.fg("accent", "Hub MCP Servers")),
			theme.fg("muted", "Select a server to inspect or manage."),
			"",
		);

		if (this.servers.length === 0) {
			lines.push(theme.fg("muted", "  No MCP servers configured. Add <cwd>/.pi/mcp.json and run /reload."));
			lines.push("");
			lines.push(theme.fg("dim", "  Esc to close"));
			lines.push("");
			lines.push(renderForkedPanelBorder(width));
			return lines.map((line) => truncateToWidth(line, width, ""));
		}

		const nameColumnWidth = computeNameColumnWidth(this.servers, width);
		for (let i = 0; i < this.servers.length; i += 1) {
			const server = this.servers[i];
			if (!server) {
				continue;
			}
			const isSelected = i === this.selectedIndex;
			lines.push(this.renderRow(server, isSelected, nameColumnWidth, width));
			const showErrorUnderRow = server.error !== undefined && server.error !== "" && server.status !== "error";
			if (showErrorUnderRow) {
				const padding = " ".repeat(2 + 2 + nameColumnWidth + 2);
				lines.push(theme.fg("muted", `${padding}error: ${server.error}`));
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
		if (this.servers.length === 0) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.onCancelSelection();
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.servers.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.servers.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.servers[this.selectedIndex];
			if (selected) {
				this.onSelectServer(selected);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelSelection();
		}
	}

	invalidate(): void {}

	private renderRow(server: McpRuntimeStatus, isSelected: boolean, nameColumnWidth: number, rowWidth: number): string {
		const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
		const namePadded = padEndVisible(server.name, nameColumnWidth);
		const name = isSelected ? theme.fg("accent", namePadded) : namePadded;
		const transport = theme.fg("muted", `[${server.transport}]`);
		const statusColor = STATUS_COLOR[server.status];
		const status = theme.fg(statusColor, server.status);
		const left = `${prefix}${name}  ${transport} ${status}`;
		const summary = buildSummaryCol(server, rowWidth, left);
		return summary.length > 0 ? `${left} ${summary}` : left;
	}
}

function buildSummaryCol(server: McpRuntimeStatus, rowWidth: number, leftWithAnsi: string): string {
	const gap = 1;
	const maxSummary = Math.max(0, rowWidth - visibleWidth(leftWithAnsi) - gap);
	if (maxSummary === 0) {
		return "";
	}
	let plain: string;
	let color: "muted" | "error";
	if (server.disabled === true) {
		plain = "disabled";
		color = "muted";
	} else if (server.status === "error" && server.error) {
		plain = "[ERROR]";
		color = "error";
	} else {
		const { tools, resources, prompts } = server.capabilities;
		plain = `${tools.length}t / ${resources.length}r / ${prompts.length}p`;
		color = "muted";
	}
	const truncated = truncateToWidth(plain, maxSummary, "");
	return theme.fg(color, truncated);
}

function computeNameColumnWidth(servers: McpRuntimeStatus[], width: number): number {
	let max = 4;
	for (const server of servers) {
		const w = visibleWidth(server.name);
		if (w > max) {
			max = w;
		}
	}
	const cap = Math.max(8, width - 52);
	return Math.min(max, 32, cap);
}

function padEndVisible(text: string, columnWidth: number): string {
	const w = visibleWidth(text);
	if (w >= columnWidth) {
		return text;
	}
	return `${text}${" ".repeat(columnWidth - w)}`;
}
