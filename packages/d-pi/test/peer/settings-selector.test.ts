import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { RemoteSettingsSelectorComponent } from "../../src/peer/tui/forked/components/settings-selector.js";

describe("remote settings selector", () => {
	it("renders thinking descriptions and original-style selection hint", () => {
		initTheme();
		const selector = new RemoteSettingsSelectorComponent(
			"high",
			["off", "medium", "high"],
			() => {},
			() => {},
		);

		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("Thinking Level"))).toBe(true);
		expect(lines.some((line) => line.includes("Select reasoning depth for thinking-capable models"))).toBe(true);
		expect(lines.some((line) => line.includes("Deep reasoning"))).toBe(true);
		expect(lines.some((line) => line.includes("Enter to select"))).toBe(true);
		expect(lines.some((line) => line.includes("Esc to go back"))).toBe(true);
	});

	it("renders a bordered selector panel", () => {
		initTheme();
		const selector = new RemoteSettingsSelectorComponent(
			"high",
			["off", "medium", "high"],
			() => {},
			() => {},
		);

		const lines = selector.render(80).map((line) => stripVTControlCharacters(line));

		expect(lines[0]).toContain("─");
		expect(lines.at(-1)).toContain("─");
	});
});
