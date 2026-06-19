import { Loader, type Terminal, Text, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DPiNativeStatusContainer } from "../src/tui/native/components/status-container.ts";
import { createDPiNativeTheme } from "../src/tui/native/theme/theme.ts";

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

describe("d-pi native status container", () => {
	// Parity marker: footer-status:native-status-loader
	it("uses upstream Loader for working state and native showStatus update semantics", () => {
		const tui = new TUI(new TestTerminal());
		const theme = createDPiNativeTheme({ color: true, colorMode: "truecolor" });
		const status = new DPiNativeStatusContainer(tui, theme);

		status.setWorking(true);
		expect(status.children[0]).toBeInstanceOf(Loader);

		status.setWorking(false);
		expect(status.children).toEqual([]);

		status.showStatus("first");
		status.showStatus("second");

		expect(status.children).toHaveLength(2);
		expect(status.children[1]).toBeInstanceOf(Text);
		expect(status.render(80).join("\n")).toContain("\x1b[38;2;102;102;102msecond\x1b[39m");
		expect(status.render(80).join("\n")).not.toContain("first");
		status.dispose();
	});
});
