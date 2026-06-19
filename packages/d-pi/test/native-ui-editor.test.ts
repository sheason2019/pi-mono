import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DPiNativeCustomEditor } from "../src/tui/native/components/custom-editor.ts";
import { createDPiNativeKeybindings } from "../src/tui/native/keybindings.ts";
import { createDPiNativeTheme, getDPiNativeEditorTheme } from "../src/tui/native/theme/theme.ts";

class TestTerminal implements Terminal {
	readonly columns = 80;
	readonly rows = 24;
	readonly kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

describe("d-pi native editor", () => {
	it("uses native app keybindings for interrupt instead of raw editor handling", () => {
		const tui = new TUI(new TestTerminal());
		const keybindings = createDPiNativeKeybindings();
		const editor = new DPiNativeCustomEditor(
			tui,
			getDPiNativeEditorTheme(createDPiNativeTheme({ color: false })),
			keybindings,
		);
		let interrupted = false;
		editor.onEscape = () => {
			interrupted = true;
		};

		editor.handleInput("\x1b");

		expect(keybindings.getKeys("app.interrupt")).toEqual(["escape"]);
		expect(interrupted).toBe(true);
	});
});
