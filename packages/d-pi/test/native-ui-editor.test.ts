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

	it("uses ctrl+c for the native clear action", () => {
		const tui = new TUI(new TestTerminal());
		const keybindings = createDPiNativeKeybindings();
		const editor = new DPiNativeCustomEditor(
			tui,
			getDPiNativeEditorTheme(createDPiNativeTheme({ color: false })),
			keybindings,
		);
		let cleared = false;
		editor.onAction("app.clear", () => {
			cleared = true;
		});

		editor.handleInput("\x03");

		expect(keybindings.getKeys("app.clear")).toEqual(["ctrl+c"]);
		expect(cleared).toBe(true);
	});

	it("exposes the native coding-agent app action keybinding set", () => {
		const keybindings = createDPiNativeKeybindings();

		expect(keybindings.getKeys("app.model.cycleForward")).toEqual(["ctrl+p"]);
		expect(keybindings.getKeys("app.model.cycleBackward")).toEqual(["shift+ctrl+p"]);
		expect(keybindings.getKeys("app.model.select")).toEqual(["ctrl+l"]);
		expect(keybindings.getKeys("app.thinking.cycle")).toEqual(["shift+tab"]);
		expect(keybindings.getKeys("app.thinking.toggle")).toEqual(["ctrl+t"]);
		expect(keybindings.getKeys("app.tools.expand")).toEqual(["ctrl+o"]);
		expect(keybindings.getKeys("app.session.new")).toEqual([]);
		expect(keybindings.getKeys("app.session.tree")).toEqual([]);
		expect(keybindings.getKeys("app.session.fork")).toEqual([]);
		expect(keybindings.getKeys("app.session.resume")).toEqual([]);
	});

	it("dispatches native app actions before falling through to the base editor", () => {
		const tui = new TUI(new TestTerminal());
		const keybindings = createDPiNativeKeybindings();
		const editor = new DPiNativeCustomEditor(
			tui,
			getDPiNativeEditorTheme(createDPiNativeTheme({ color: false })),
			keybindings,
		);
		let selectedModel = false;
		editor.onAction("app.model.select", () => {
			selectedModel = true;
		});

		editor.handleInput("\f");

		expect(selectedModel).toBe(true);
	});
});
