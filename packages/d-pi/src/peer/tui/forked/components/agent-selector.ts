import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../components/index.js";
import type { RemoteInteractiveGroupAgentView } from "../../interactive/remote-interactive-view.js";
import { renderForkedPanelBorder } from "./selector-themes.js";

export class RemoteAgentSelectorComponent implements Component, Focusable {
	private selectedIndex = 0;
	focused = false;

	constructor(
		private readonly agents: RemoteInteractiveGroupAgentView[],
		private readonly currentAgentId: string,
		private readonly onSelectAgent: (agent: RemoteInteractiveGroupAgentView) => void | Promise<void>,
		private readonly onCancelSelection: () => void,
		private readonly onSelectError?: (error: unknown) => void,
	) {}

	getFocusTarget(): Component {
		return this;
	}

	render(width: number): string[] {
		const lines = [
			renderForkedPanelBorder(width),
			"",
			theme.bold(theme.fg("accent", "Agents")),
			theme.fg("muted", "Select an agent visible to the current token."),
			"",
		];

		if (this.agents.length === 0) {
			lines.push(theme.fg("muted", "  No agents are visible yet."));
			lines.push("");
			lines.push(theme.fg("dim", "  Esc to close"));
			lines.push("");
			lines.push(renderForkedPanelBorder(width));
			return lines.map((line) => truncateToWidth(line, width, ""));
		}

		const nameColumnWidth = computeNameColumnWidth(this.agents, width);
		for (let i = 0; i < this.agents.length; i += 1) {
			const agent = this.agents[i];
			if (!agent) {
				continue;
			}
			lines.push(this.renderRow(agent, i === this.selectedIndex, nameColumnWidth, width));
		}

		lines.push("");
		lines.push(theme.fg("dim", "  Enter to switch · Esc to close"));
		lines.push("");
		lines.push(renderForkedPanelBorder(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.agents.length === 0) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.onCancelSelection();
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.agents.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.agents.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.agents[this.selectedIndex];
			if (selected) {
				void Promise.resolve(this.onSelectAgent(selected)).catch((error: unknown) => {
					this.onSelectError?.(error);
				});
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelSelection();
		}
	}

	invalidate(): void {}

	private renderRow(
		agent: RemoteInteractiveGroupAgentView,
		isSelected: boolean,
		nameColumnWidth: number,
		rowWidth: number,
	): string {
		const prefix = isSelected ? theme.fg("accent", "-> ") : "   ";
		const label = agent.name ? `${agent.id} (${agent.name})` : agent.id;
		const labelPadded = padEndVisible(label, nameColumnWidth);
		const name = isSelected ? theme.fg("accent", labelPadded) : labelPadded;
		const active = agent.id === this.currentAgentId ? theme.fg("success", "[current]") : "";
		const status = agent.isRunning ? theme.fg("success", "working") : theme.fg("muted", "idle");
		const kind = agent.kind ? theme.fg("muted", `[${agent.kind}]`) : "";
		const left = [prefix + name, active, kind, status].filter((part) => part.length > 0).join(" ");
		const summary = buildSummary(agent, rowWidth, left);
		return summary.length > 0 ? `${left} ${summary}` : left;
	}
}

function buildSummary(agent: RemoteInteractiveGroupAgentView, rowWidth: number, leftWithAnsi: string): string {
	const maxSummary = Math.max(0, rowWidth - visibleWidth(leftWithAnsi) - 1);
	if (maxSummary === 0) {
		return "";
	}
	const suffix = agent.messageCount === 1 ? "message" : "messages";
	return theme.fg("muted", truncateToWidth(`${agent.messageCount} ${suffix}`, maxSummary, ""));
}

function computeNameColumnWidth(agents: RemoteInteractiveGroupAgentView[], width: number): number {
	let max = 5;
	for (const agent of agents) {
		const label = agent.name ? `${agent.id} (${agent.name})` : agent.id;
		const w = visibleWidth(label);
		if (w > max) {
			max = w;
		}
	}
	const cap = Math.max(12, width - 42);
	return Math.min(max, 48, cap);
}

function padEndVisible(text: string, columnWidth: number): string {
	const w = visibleWidth(text);
	if (w >= columnWidth) {
		return text;
	}
	return `${text}${" ".repeat(columnWidth - w)}`;
}
