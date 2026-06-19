import { Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { createDPiNativeTheme, type DPiNativeTheme } from "../theme/theme.ts";

export class DPiNativeStatusContainer extends Container {
	private readonly tui: TUI;
	private readonly theme: DPiNativeTheme;
	private loadingAnimation: Loader | undefined;
	private lastStatusSpacer: Spacer | undefined;
	private lastStatusText: Text | undefined;

	constructor(tui: TUI, theme: DPiNativeTheme = createDPiNativeTheme()) {
		super();
		this.tui = tui;
		this.theme = theme;
	}

	setWorking(working: boolean): void {
		if (!working) {
			this.stopWorkingLoader();
			return;
		}
		if (this.loadingAnimation) {
			return;
		}
		this.clear();
		this.loadingAnimation = new Loader(
			this.tui,
			(spinner) => this.theme.fg("accent", spinner),
			(text) => this.theme.fg("muted", text),
			"Working...",
		);
		this.addChild(this.loadingAnimation);
	}

	showStatus(message: string): void {
		this.stopWorkingLoader();
		const last = this.children.length > 0 ? this.children[this.children.length - 1] : undefined;
		const secondLast = this.children.length > 1 ? this.children[this.children.length - 2] : undefined;
		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(this.theme.fg("dim", message));
			this.tui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(this.theme.fg("dim", message), 1, 0);
		this.addChild(spacer);
		this.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.tui.requestRender();
	}

	dispose(): void {
		this.stopWorkingLoader();
	}

	private stopWorkingLoader(): void {
		if (!this.loadingAnimation) {
			return;
		}
		this.removeChild(this.loadingAnimation);
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
	}
}
