import { opendir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_TUI_UX_PARITY_GROUPS, TUI_UX_PARITY_MATRIX } from "../src/tui/ux-parity.ts";

const packageRootUrl = new URL("..", import.meta.url);
const packageRoot = fileURLToPath(packageRootUrl);
const tuiSourceRoot = fileURLToPath(new URL("../src/tui", import.meta.url));
const requiredGroups = [
	"startup-banner",
	"input-keybindings",
	"message-rendering",
	"streaming-tools",
	"commands-selectors",
	"footer-status",
	"remote-recovery",
] as const;

async function collectSourceFiles(pathname: string): Promise<string[]> {
	const entries = await opendir(pathname);
	const files: string[] = [];
	for await (const entry of entries) {
		const child = join(pathname, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectSourceFiles(child)));
			continue;
		}
		if (entry.isFile() && child.endsWith(".ts")) {
			files.push(child);
		}
	}
	return files.sort();
}

describe("remote-first TUI UX parity matrix", () => {
	// TODO parity marker: startup-banner:banner-resources-diagnostics
	// TODO parity marker: input-keybindings:editable-input-bindings
	// TODO parity marker: message-rendering:assistant-and-user-transcript
	// TODO parity marker: commands-selectors:command-and-agent-surfaces
	// TODO parity marker: footer-status:runtime-status-footer
	it("declares every required UX parity group", () => {
		expect(REQUIRED_TUI_UX_PARITY_GROUPS).toEqual(requiredGroups);
		for (const group of requiredGroups) {
			expect(TUI_UX_PARITY_MATRIX.some((item) => item.group === group)).toBe(true);
		}
	});

	it("keeps every required parity item actionable and test-traceable", async () => {
		for (const item of TUI_UX_PARITY_MATRIX) {
			expect(item.id).toMatch(new RegExp(`^${item.group}:`));
			expect(item.interactiveModeBaseline.trim()).not.toBe("");
			expect(item.remoteImplementation).toMatch(/implemented|planned/);
			expect(item.testRefs.length).toBeGreaterThan(0);
			expect(item.testRefs.some((ref) => ref.case.includes(item.id))).toBe(true);
			for (const ref of item.testRefs) {
				expect(ref.file).toMatch(/^test\/.*\.test\.ts$/);
				expect(ref.case.trim()).not.toBe("");
				const testFile = join(packageRoot, ref.file);
				const fileStats = await stat(testFile);
				expect(fileStats.isFile()).toBe(true);
				const source = await readFile(testFile, "utf8");
				expect(source).toContain(ref.case);
			}
		}
	});

	it("does not reference the removed coding-agent package from TUI source", async () => {
		const forbiddenTerms = ["@sheason/" + "pi-" + "coding-" + "agent"];
		const matches: Array<{ file: string; term: string }> = [];

		for (const file of await collectSourceFiles(tuiSourceRoot)) {
			const text = await readFile(file, "utf8");
			for (const term of forbiddenTerms) {
				if (text.includes(term)) {
					matches.push({ file: relative(packageRoot, file), term });
				}
			}
		}

		expect(matches).toEqual([]);
	});
});
