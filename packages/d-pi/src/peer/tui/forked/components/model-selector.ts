import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../../components/index.js";
import type { RemoteInteractiveSessionView } from "../../interactive/remote-interactive-view.js";
import { renderForkedPanelBorder } from "./selector-themes.js";

type AvailableModel = RemoteInteractiveSessionView["availableModels"][number];
type CurrentModel = RemoteInteractiveSessionView["model"];

export class RemoteModelSelectorComponent implements Component, Focusable {
	private readonly searchInput = new Input();
	private filteredModels: AvailableModel[];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	getFocusTarget(): Component {
		return this;
	}

	constructor(
		private readonly models: AvailableModel[],
		private readonly currentModel: CurrentModel,
		private readonly onSelectModel: (model: AvailableModel) => void | Promise<void>,
		private readonly onCancelSelection: () => void,
		private readonly onSelectError?: (error: unknown) => void,
	) {
		this.filteredModels = [...models];
		this.searchInput.onEscape = () => this.onCancelSelection();
		this.searchInput.onSubmit = () => {
			this.submitSelectedModel();
		};
	}

	render(width: number): string[] {
		const lines = [
			renderForkedPanelBorder(width),
			"",
			theme.bold(theme.fg("accent", "Select Model")),
			theme.fg("muted", "Search models and press Enter to switch."),
			"",
			...this.searchInput.render(width),
			"",
		];

		if (this.filteredModels.length === 0) {
			lines.push(theme.fg("muted", "  No matching models"));
		} else {
			const maxVisible = 8;
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
			for (let i = startIndex; i < endIndex; i += 1) {
				const model = this.filteredModels[i];
				if (!model) {
					continue;
				}
				const selected = i === this.selectedIndex;
				const current =
					this.currentModel?.provider === model.provider && this.currentModel?.modelId === model.modelId
						? " ✓"
						: "";
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const main = selected ? theme.fg("accent", model.modelId) : model.modelId;
				const provider = theme.fg("muted", ` [${model.provider}]`);
				const label = model.label && model.label !== model.modelId ? theme.fg("muted", ` ${model.label}`) : "";
				lines.push(`${prefix}${main}${provider}${label}${theme.fg("success", current)}`);
			}
			if (startIndex > 0 || endIndex < this.filteredModels.length) {
				lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`));
			}
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				lines.push("");
				lines.push(theme.fg("muted", `  Model Name: ${selectedModel.label}`));
			}
		}

		lines.push("");
		lines.push(theme.fg("dim", "  Enter to select · Esc to go back"));
		lines.push("");
		lines.push(renderForkedPanelBorder(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.submitSelectedModel();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelSelection();
			return;
		}

		this.searchInput.handleInput(data);
		this.filterModels(this.searchInput.getValue());
	}

	invalidate(): void {}

	private submitSelectedModel(): void {
		const selected = this.filteredModels[this.selectedIndex];
		if (!selected) {
			return;
		}
		void Promise.resolve(this.onSelectModel(selected)).catch((error: unknown) => {
			this.onSelectError?.(error);
		});
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(
					this.models,
					query,
					(model) => `${model.provider}/${model.modelId} ${model.modelId} ${model.label}`,
				)
			: [...this.models];
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}
}
