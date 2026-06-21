import { describe, expect, it } from "vitest";
import { createDPiNativeTheme, getDPiNativeMarkdownTheme } from "../src/tui/native/theme/theme.ts";

describe("d-pi native interactive theme", () => {
	it("matches upstream dark theme tokens and reset behavior", () => {
		const theme = createDPiNativeTheme({ color: true, colorMode: "truecolor" });
		const markdownTheme = getDPiNativeMarkdownTheme(theme);

		expect(theme.fg("accent", "pi")).toBe("\x1b[38;2;138;190;183mpi\x1b[39m");
		expect(theme.fg("mdHeading", "[Skills]")).toBe("\x1b[38;2;240;198;116m[Skills]\x1b[39m");
		expect(theme.fg("dim", "Press ctrl+o")).toBe("\x1b[38;2;102;102;102mPress ctrl+o\x1b[39m");
		expect(theme.bg("userMessageBg", " Hi ")).toBe("\x1b[48;2;52;53;65m Hi \x1b[49m");
		expect(markdownTheme.code("`x`")).toBe("\x1b[38;2;138;190;183m`x`\x1b[39m");
	});
});
