import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentTsSource } from "../src/agent-config.ts";
import { readLoadedAgentDefinitionFromTs } from "../src/agent-loader.ts";

let tempDir: string | undefined;

function createWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-config-"));
	return tempDir;
}

function dPiDefinitionUrl(): string {
	return pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
}

function useSourceDefinitionImport(source: string): string {
	const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
	return source.replaceAll('from "@sheason/d-pi"', `from ${JSON.stringify(dPiDefinitionUrl)}`);
}

function writeAgentTs(agentDir: string, source: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "agent.ts"), source);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("buildAgentTsSource", () => {
	it("emits executable define DSL without string model migration paths", async () => {
		const workspace = createWorkspace();
		writeAgentTs(
			join(workspace, "agents", "root"),
			useSourceDefinitionImport(
				buildAgentTsSource({
					name: "root",
					description: "Root",
				}),
			),
		);
		const agentDir = join(workspace, "agents", "reviewer");
		writeAgentTs(
			agentDir,
			useSourceDefinitionImport(
				buildAgentTsSource({
					name: "reviewer",
					parentName: "root",
					description: "Reviewer",
					roles: ["reviewer"],
					toolNames: ["dispatch_read", "team"],
					modelDefinition: { provider: "anthropic", name: "claude-sonnet-4" },
				}),
			),
		);

		const written = await readLoadedAgentDefinitionFromTs(agentDir);
		expect(written).toMatchObject({
			name: "reviewer",
			description: "Reviewer",
			roles: ["reviewer"],
			model: { provider: "anthropic", name: "claude-sonnet-4" },
			tools: [{ name: "dispatch_read" }, { name: "team" }],
		});
		const source = readFileSync(join(agentDir, "agent.ts"), "utf-8");
		expect(source).toContain('import parentAgent from "../root/agent.ts";');
		expect(source).toContain("export default defineAgent({");
		expect(source).toContain('model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" })');
	});

	it("uses executable agent.ts evaluation instead of static source parsing", async () => {
		const workspace = createWorkspace();
		const agentDir = join(workspace, "agents", "dynamic");
		writeAgentTs(
			agentDir,
			[
				`import { createDispatchReadTool, createTeamTool, defineAgent, defineContextFile, defineModel, defineRole, defineSkill } from ${JSON.stringify(dPiDefinitionUrl())};`,
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

		const written = await readLoadedAgentDefinitionFromTs(agentDir);
		expect(written).toMatchObject({
			name: "dynamic",
			description: "Dynamic reviewer",
			roles: ["reviewer"],
			model: { provider: "unknown", name: "old-model" },
			tools: [{ name: "dispatch_read" }, { name: "team" }],
		});
	});

	it("emits rich agent-local model definitions", async () => {
		const workspace = createWorkspace();
		const agentDir = join(workspace, "agents", "rich");
		writeAgentTs(
			agentDir,
			useSourceDefinitionImport(
				buildAgentTsSource({
					name: "rich",
					description: "Rich model agent",
					modelDefinition: {
						id: "gpt-local",
						name: "GPT Local",
						description: "Generated rich model",
						provider: {
							provider: "openai",
							api: "openai-responses",
							baseUrl: "https://api.openai.com/v1",
							apiKey: "agent-key",
							authHeader: true,
							headers: { "x-agent": "rich" },
						},
						reasoning: true,
						thinkingLevel: "high",
						input: ["text", "image"],
						cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
						contextWindow: 200_000,
						maxTokens: 32_000,
						headers: { "x-model": "local" },
					},
				}),
			),
		);

		const written = await readLoadedAgentDefinitionFromTs(agentDir);
		expect(written?.model).toMatchObject({
			id: "gpt-local",
			name: "GPT Local",
			description: "Generated rich model",
			provider: {
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "agent-key",
				authHeader: true,
				headers: { "x-agent": "rich" },
			},
			reasoning: true,
			thinkingLevel: "high",
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			headers: { "x-model": "local" },
		});
		const source = readFileSync(join(agentDir, "agent.ts"), "utf-8");
		expect(source).toContain("defineOpenAIProvider");
		expect(source).toContain('apiKey: "agent-key"');
		expect(source).toContain('description: "Generated rich model"');
		expect(source).toContain("contextWindow: 200000");
	});
});
