import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceDefinitionFromFile, readWorkspaceDefinitionFromTs } from "../src/workspace-definition.ts";

let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-workspace-definition-"));
	return tempDir;
}

function linkCurrentDPiPackage(workspace: string): void {
	const dPiPackageDir = join(workspace, "node_modules", "@sheason", "d-pi");
	mkdirSync(dPiPackageDir, { recursive: true });
	writeFileSync(
		join(dPiPackageDir, "package.json"),
		JSON.stringify({ name: "@sheason/d-pi", type: "module", exports: "./index.js" }),
	);
	writeFileSync(
		join(dPiPackageDir, "index.js"),
		`export * from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "index.ts")).href)};\n`,
	);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("workspace definition loader", () => {
	it("loads workspace d-pi.ts default export with keyed models and sources", async () => {
		const workspace = freshWorkspace();
		linkCurrentDPiPackage(workspace);
		writeFileSync(
			join(workspace, "d-pi.ts"),
			[
				'import { defineModel, defineSource, defineWorkspace } from "@sheason/d-pi";',
				"",
				"export default defineWorkspace({",
				"\tmodels: {",
				'\t\t"anthropic/claude-sonnet-4": defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),',
				"\t},",
				"\tsources: {",
				'\t\t"lark-bot": defineSource({ execute: (output) => output("hello") }),',
				"\t},",
				"});",
				"",
			].join("\n"),
		);

		const workspaceDefinition = await readWorkspaceDefinitionFromTs(workspace);

		expect(workspaceDefinition?.models["anthropic/claude-sonnet-4"]).toEqual({
			provider: "anthropic",
			name: "claude-sonnet-4",
		});
		expect(workspaceDefinition?.sources["lark-bot"]?.name).toBe("lark-bot");
		expect(workspaceDefinition?.sources["lark-bot"]?.execute).toEqual(expect.any(Function));
	});

	it("returns undefined when d-pi.ts does not exist", async () => {
		await expect(readWorkspaceDefinitionFromTs(freshWorkspace())).resolves.toBeUndefined();
	});

	it("rejects invalid default exports", async () => {
		const workspace = freshWorkspace();
		const filePath = join(workspace, "d-pi.ts");
		writeFileSync(filePath, "export default { models: { invalid: {} } };\n");

		await expect(loadWorkspaceDefinitionFromFile(filePath)).rejects.toThrow(/Workspace model key/);
	});
});
