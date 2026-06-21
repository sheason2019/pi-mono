import type { Component } from "@earendil-works/pi-tui";
import { createDPiNativeTheme } from "../theme/theme.ts";

export class DPiNativeDynamicBorder implements Component {
	private readonly color: (text: string) => string;

	constructor(color: (text: string) => string = (text) => createDPiNativeTheme().fg("border", text)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
