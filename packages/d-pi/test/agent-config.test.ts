import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentTsSource, persistModelInAgentTs } from "../src/agent-config.ts";
import { readLoadedAgentDefinitionFromTs } from "../src/agent-loader.ts";

let tempDir: string | undefined;

function createWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-config-"));
	return tempDir;
}

function useSourceDefinitionImport(source: string): string {
	const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "agent-definition.ts")).href;
	return source.replace(
		'import { defineAgent, defineContextFile, defineModel, defineSkill, defineTool } from "@sheason/d-pi";',
		`import { defineAgent, defineContextFile, defineModel, defineSkill, defineTool } from ${JSON.stringify(dPiDefinitionUrl)};`,
	);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("persistModelInAgentTs", () => {
	it("rewrites generated define DSL while preserving parent, roles, and tools", async () => {
		const workspace = createWorkspace();
		const rootDir = join(workspace, "agents", "root");
		const reviewerDir = join(workspace, "agents", "reviewer");
		mkdirSync(rootDir, { recursive: true });
		mkdirSync(reviewerDir, { recursive: true });
		writeFileSync(
			join(rootDir, "agent.ts"),
			useSourceDefinitionImport(
				buildAgentTsSource({
					name: "root",
					parentName: undefined,
					description: "Root",
				}),
			),
		);
		writeFileSync(
			join(reviewerDir, "agent.ts"),
			useSourceDefinitionImport(
				buildAgentTsSource({
					name: "reviewer",
					parentName: "root",
					description: "Reviewer",
					roles: ["reviewer"],
					includeTools: ["dispatch_read", "team"],
					model: "unknown/old-model",
				}),
			),
		);

		await persistModelInAgentTs(reviewerDir, "anthropic/claude-sonnet-4");

		const written = await readLoadedAgentDefinitionFromTs(reviewerDir);
		expect(written).toMatchObject({
			name: "reviewer",
			description: "Reviewer",
			roles: ["reviewer"],
			model: { provider: "anthropic", name: "claude-sonnet-4" },
			tools: [{ name: "dispatch_read" }, { name: "team" }],
		});
		const source = readFileSync(join(reviewerDir, "agent.ts"), "utf-8");
		expect(source).toContain('import parentAgent from "../root/agent.ts";');
		expect(source).toContain("export default defineAgent({");
		expect(source).toContain('model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" })');
	});

	it("uses executable agent.ts evaluation instead of static source parsing", async () => {
		const workspace = createWorkspace();
		const agentDir = join(workspace, "agents", "dynamic");
		mkdirSync(agentDir, { recursive: true });
		const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "agent-definition.ts")).href;
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				`import { defineAgent, defineContextFile, defineModel, defineRole, defineSkill, defineTool } from ${JSON.stringify(dPiDefinitionUrl)};`,
				"",
				'const role = defineRole("reviewer");',
				'const toolNames = ["dispatch_read", "team"];',
				"",
				"export default defineAgent({",
				"\tdescription: `Dynamic reviewer`,",
				"\troles: [role],",
				'\tmodel: defineModel({ provider: "unknown", name: "old-model" }),',
				'\tskills: defineSkill({ dir: "./skills" }),',
				"\ttools: toolNames.map((name) => defineTool({ name })),",
				"\tcontextFiles: [",
				'\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),',
				'\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),',
				"\t],",
				"});",
				"",
			].join("\n"),
		);

		await persistModelInAgentTs(agentDir, "anthropic/claude-sonnet-4");

		const written = await readLoadedAgentDefinitionFromTs(agentDir);
		expect(written).toMatchObject({
			name: "dynamic",
			description: "Dynamic reviewer",
			roles: ["reviewer"],
			model: { provider: "anthropic", name: "claude-sonnet-4" },
			tools: [{ name: "dispatch_read" }, { name: "team" }],
		});
	});
});
