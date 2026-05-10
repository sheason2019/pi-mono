import { type Component, type Focusable, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../components/index.js";
import type { RemoteInteractiveSessionView } from "../../interactive/remote-interactive-view.js";
import { getForkedSelectListTheme, renderForkedPanelBorder } from "./selector-themes.js";

type ThinkingLevel = RemoteInteractiveSessionView["availableThinkingLevels"][number];

const THINKING_DESCRIPTIONS: Record<string, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

export class RemoteSettingsSelectorComponent implements Component, Focusable {
	private readonly selectList: SelectList;
	focused = false;

	constructor(
		_currentThinkingLevel: string,
		availableThinkingLevels: string[],
		private readonly onSelectThinkingLevel: (level: ThinkingLevel) => void | Promise<void>,
		private readonly onCancelSelection: () => void,
	) {
		this.selectList = new SelectList(
			availableThinkingLevels.map((level) => ({
				value: level,
				label: level,
				description: THINKING_DESCRIPTIONS[level] ?? level,
			})),
			Math.min(availableThinkingLevels.length, 10),
			getForkedSelectListTheme(),
			{ minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 },
		);

		const currentIndex = availableThinkingLevels.indexOf(_currentThinkingLevel);
		if (currentIndex >= 0) {
			this.selectList.setSelectedIndex(currentIndex);
		}
		this.selectList.onSelect = (item) => {
			void this.onSelectThinkingLevel(item.value);
		};
		this.selectList.onCancel = () => this.onCancelSelection();
	}

	getFocusTarget(): Component {
		return this.selectList;
	}

	render(width: number): string[] {
		const lines = [
			renderForkedPanelBorder(width),
			"",
			theme.bold(theme.fg("accent", "Thinking Level")),
			theme.fg("muted", "Select reasoning depth for thinking-capable models"),
			"",
			...this.selectList.render(width),
			"",
			theme.fg("dim", "  Enter to select · Esc to go back"),
			"",
			renderForkedPanelBorder(width),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		this.selectList.invalidate();
	}
}
