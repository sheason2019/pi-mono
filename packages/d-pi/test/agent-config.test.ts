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
	const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
	return source.replaceAll('from "@sheason/d-pi"', `from ${JSON.stringify(dPiDefinitionUrl)}`);
}

function useSourceDefinitionImportInAgentFile(agentDir: string): void {
	const agentFilePath = join(agentDir, "agent.ts");
	writeFileSync(agentFilePath, useSourceDefinitionImport(readFileSync(agentFilePath, "utf-8")));
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
		useSourceDefinitionImportInAgentFile(reviewerDir);

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
		const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				`import { createDispatchReadTool, createTeamTool, defineAgent, defineContextFile, defineModel, defineRole, defineSkill } from ${JSON.stringify(dPiDefinitionUrl)};`,
				"",
				'const role = defineRole("reviewer");',
				"",
				"export default defineAgent({",
				"\tdescription: `Dynamic reviewer`,",
				"\troles: [role],",
				'\tmodel: defineModel({ provider: "unknown", name: "old-model" }),',
				'\tskills: defineSkill({ dir: "./skills" }),',
				"\ttools: [createDispatchReadTool(), createTeamTool()],",
				"\tcontextFiles: [",
				'\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),',
				'\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),',
				"\t],",
				"});",
				"",
			].join("\n"),
		);

		await persistModelInAgentTs(agentDir, "anthropic/claude-sonnet-4");
		useSourceDefinitionImportInAgentFile(agentDir);

		const written = await readLoadedAgentDefinitionFromTs(agentDir);
		expect(written).toMatchObject({
			name: "dynamic",
			description: "Dynamic reviewer",
			roles: ["reviewer"],
			model: { provider: "anthropic", name: "claude-sonnet-4" },
			tools: [{ name: "dispatch_read" }, { name: "team" }],
		});
	});

	it("preserves a selected rich agent-local model when persisting a model selection", async () => {
		const workspace = createWorkspace();
		const agentDir = join(workspace, "agents", "rich");
		mkdirSync(agentDir, { recursive: true });
		const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				`import { defineAgent, defineModel, defineSkill } from ${JSON.stringify(dPiDefinitionUrl)};`,
				"",
				"export default defineAgent({",
				'\tdescription: "Rich model agent",',
				"\tmodel: defineModel({",
				'\t\tid: "gpt-local",',
				'\t\tname: "GPT Local",',
				'\t\tprovider: { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "agent-key", authHeader: true, headers: { "x-agent": "rich" } },',
				"\t\treasoning: true,",
				'\t\tthinkingLevelMap: { off: null, high: "high" },',
				'\t\tinput: ["text", "image"],',
				"\t\tcost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },",
				"\t\tcontextWindow: 200000,",
				"\t\tmaxTokens: 32000,",
				'\t\theaders: { "x-model": "local" },',
				"\t}),",
				'\tskills: defineSkill({ dir: "./skills" }),',
				"});",
				"",
			].join("\n"),
		);

		await persistModelInAgentTs(agentDir, "openai/gpt-local");
		useSourceDefinitionImportInAgentFile(agentDir);

		const written = await readLoadedAgentDefinitionFromTs(agentDir);
		expect(written?.model).toMatchObject({
			id: "gpt-local",
			name: "GPT Local",
			provider: {
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "agent-key",
				authHeader: true,
				headers: { "x-agent": "rich" },
			},
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high" },
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			headers: { "x-model": "local" },
		});
		const source = readFileSync(join(agentDir, "agent.ts"), "utf-8");
		expect(source).toContain("defineOpenAIProvider");
		expect(source).toContain('apiKey: "agent-key"');
		expect(source).toContain("contextWindow: 200000");
	});
});
