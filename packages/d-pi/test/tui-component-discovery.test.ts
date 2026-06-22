import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverTuiComponentFiles,
	isAgentTuiComponentDefinition,
	loadTuiComponentDefinitionFromFile,
} from "../src/tui-components/tui-component-discovery.ts";

let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-tui-components-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("workspace TUI component discovery", () => {
	it("discovers only top-level .ts files under tui-components in deterministic order", () => {
		const workspace = freshWorkspace();
		mkdirSync(join(workspace, "tui-components", "nested"), { recursive: true });
		writeFileSync(join(workspace, "tui-components", "b.ts"), "export default {};");
		writeFileSync(join(workspace, "tui-components", "a.ts"), "export default {};");
		writeFileSync(join(workspace, "tui-components", "ignored.js"), "export default {};");
		writeFileSync(join(workspace, "tui-components", "nested", "hidden.ts"), "export default {};");

		expect(discoverTuiComponentFiles(workspace).map((entry) => entry.name)).toEqual(["a.ts", "b.ts"]);
	});

	it("returns an empty list when tui-components does not exist", () => {
		expect(discoverTuiComponentFiles(freshWorkspace())).toEqual([]);
	});

	it("loads and validates default exported defineTuiComponent definitions", async () => {
		const workspace = freshWorkspace();
		mkdirSync(join(workspace, "tui-components"), { recursive: true });
		const componentPath = join(workspace, "tui-components", "meta.ts");
		writeFileSync(
			componentPath,
			[
				`export { default } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "public", "d-pi-message.ts")).href)};`,
				"",
			].join("\n"),
		);

		const component = await loadTuiComponentDefinitionFromFile(componentPath);

		expect(component.customType).toBe("d-pi-message");
		expect(component.render).toEqual(expect.any(Function));
		expect(isAgentTuiComponentDefinition(component)).toBe(true);
		expect(isAgentTuiComponentDefinition({ customType: "x" })).toBe(false);
	});
});
