import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadAgentDefinitionFromFile,
	normalizeLoadedAgentDefinition,
	readLoadedAgentDefinitionFromTs,
} from "../src/agent-loader.ts";

let tempDir: string | undefined;

function createTempWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi agent loader "));
	return tempDir;
}

function writeAgentModule(workspaceRoot: string, agentName: string, source: string): string {
	const agentDir = join(workspaceRoot, "agents", agentName);
	mkdirSync(agentDir, { recursive: true });
	const agentFilePath = join(agentDir, "agent.mjs");
	writeFileSync(agentFilePath, source);
	return agentFilePath;
}

function executableTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text" as const, text: name }] };
		},
	};
}

function executableToolSource(name: string): string {
	return [
		"defineTool({",
		`\t\tname: ${JSON.stringify(name)},`,
		`\t\tdescription: ${JSON.stringify(`${name} description`)},`,
		'\t\tparameters: { type: "object", properties: {} },',
		"\t\tasync execute() {",
		`\t\t\treturn { content: [{ type: "text", text: ${JSON.stringify(name)} }] };`,
		"\t\t},",
		"\t})",
	].join("\n");
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("normalizeLoadedAgentDefinition", () => {
	it("derives the agent name from the parent directory and returns file metadata", () => {
		const parent = { description: "root", roles: [], tools: [], skills: { dir: "./skills" }, contextFiles: [] };
		const agentFilePath = "/tmp/workspace/agents/reviewer/agent.ts";

		const loaded = normalizeLoadedAgentDefinition(agentFilePath, {
			parent,
			description: "reviewer",
			roles: ["reviewer"],
			tools: [executableTool("dispatch_read")],
			skills: { dir: "./skills" },
			contextFiles: [{ type: "context", path: "./AGENTS.md" }],
		});

		expect(loaded.name).toBe("reviewer");
		expect(loaded.agentDir).toBe("/tmp/workspace/agents/reviewer");
		expect(loaded.agentFilePath).toBe("/tmp/workspace/agents/reviewer/agent.ts");
		expect(loaded.description).toBe("reviewer");
		expect(loaded.parent).toBe(parent);
	});

	it("throws when the loaded definition is missing", () => {
		expect(() => normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", undefined)).toThrow(
			/default export.*object/i,
		);
	});

	it("throws when the loaded definition is not an object", () => {
		expect(() => normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", "reviewer")).toThrow(
			/default export.*object/i,
		);
	});

	it("throws when required fields are missing", () => {
		expect(() => normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {})).toThrow(
			/tools must be an array/i,
		);
	});

	it("throws when nested fields have invalid shapes", () => {
		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [executableTool("dispatch_read")],
				skills: null,
				contextFiles: [],
			}),
		).toThrow(/skills.dir must be a string/i);

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [executableTool("dispatch_read")],
				skills: { dir: "./skills" },
				contextFiles: [{ type: "invalid", path: "./AGENTS.md" }],
			}),
		).toThrow(/contextFiles.*type/i);

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [{ name: "dispatch_read" }],
				skills: { dir: "./skills" },
				contextFiles: [],
			}),
		).toThrow(/tools\[0\]\.label/i);
	});

	it("accepts rich model definitions and rejects invalid rich model shapes", () => {
		const rich = normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
			model: {
				id: "gpt-test",
				provider: {
					provider: "openai",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
				},
				contextWindow: 200_000,
				maxTokens: 32_000,
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			},
			models: [
				{
					id: "claude-test",
					provider: "anthropic",
					contextWindow: 100_000,
				},
			],
			tools: [executableTool("dispatch_read")],
			skills: { dir: "./skills" },
			contextFiles: [],
		});

		expect(rich.model).toMatchObject({
			id: "gpt-test",
			provider: { provider: "openai", api: "openai-responses" },
			contextWindow: 200_000,
		});
		expect(rich.models).toEqual([{ id: "claude-test", provider: "anthropic", contextWindow: 100_000 }]);

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				model: { id: "bad", provider: "openai" },
				tools: [],
				skills: { dir: "./skills" },
				contextFiles: [],
			}),
		).toThrow(/model.contextWindow must be a number/i);

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				model: { id: "bad", provider: { provider: "openai", api: "openai-responses" }, contextWindow: 1 },
				tools: [],
				skills: { dir: "./skills" },
				contextFiles: [],
			}),
		).toThrow(/model.provider.baseUrl must be a string/i);
	});
});

describe("loadAgentDefinitionFromFile", () => {
	it("dynamically imports an agent module from a path with spaces and normalizes the result", async () => {
		const workspaceRoot = createTempWorkspace();
		const agentFilePath = writeAgentModule(
			workspaceRoot,
			"reviewer",
			[
				"const parent = {",
				'  description: "root",',
				"  roles: [],",
				"  tools: [],",
				'  skills: { dir: "./skills" },',
				"  contextFiles: [],",
				"};",
				"export default {",
				"  parent,",
				'  description: "reviewer",',
				'  roles: ["reviewer"],',
				'  model: { provider: "anthropic", name: "claude-sonnet-4" },',
				"  tools: [",
				"    {",
				'      name: "dispatch_read",',
				'      label: "dispatch_read",',
				'      description: "dispatch_read description",',
				'      parameters: { type: "object", properties: {} },',
				"      async execute() {",
				'        return { content: [{ type: "text", text: "dispatch_read" }] };',
				"      },",
				"    },",
				"  ],",
				'  skills: { dir: "./skills" },',
				'  contextFiles: [{ type: "context", path: "./AGENTS.md" }],',
				"};",
			].join("\n"),
		);

		const loaded = await loadAgentDefinitionFromFile(agentFilePath);

		expect(loaded.name).toBe("reviewer");
		expect(loaded.agentDir).toBe(join(workspaceRoot, "agents", "reviewer"));
		expect(loaded.agentFilePath).toBe(agentFilePath);
		expect(loaded.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(loaded.parent).toEqual({
			description: "root",
			roles: [],
			tools: [],
			skills: { dir: "./skills" },
			contextFiles: [],
		});
	});
});

describe("readLoadedAgentDefinitionFromTs", () => {
	it("loads workspace agent.ts files that import define helpers from @sheason/d-pi", () => {
		const workspaceRoot = createTempWorkspace();
		const agentDir = join(workspaceRoot, "agents", "root");
		const loaderUrl = pathToFileURL(join(process.cwd(), "src", "agent-loader.ts")).href;
		const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "agent-definition.ts")).href;
		const dPiPackageDir = join(workspaceRoot, "node_modules", "@sheason", "d-pi");
		mkdirSync(dPiPackageDir, { recursive: true });
		writeFileSync(
			join(dPiPackageDir, "package.json"),
			JSON.stringify({ name: "@sheason/d-pi", type: "module", exports: "./index.js" }),
		);
		writeFileSync(join(dPiPackageDir, "index.js"), `export * from ${JSON.stringify(dPiDefinitionUrl)};\n`);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				'import { defineAgent, defineContextFile, defineSkill, defineTool } from "@sheason/d-pi";',
				"",
				"export default defineAgent({",
				'\tdescription: "External workspace root",',
				'\tskills: defineSkill({ dir: "./skills" }),',
				`\ttools: [${executableToolSource("dispatch_read")}],`,
				"\tcontextFiles: [",
				'\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),',
				'\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),',
				"\t],",
				"});",
				"",
			].join("\n"),
		);

		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				[
					`import { readLoadedAgentDefinitionFromTs } from ${JSON.stringify(loaderUrl)};`,
					`const loaded = await readLoadedAgentDefinitionFromTs(${JSON.stringify(agentDir)});`,
					"console.log(JSON.stringify({ name: loaded?.name, description: loaded?.description, tools: loaded?.tools }));",
				].join("\n"),
			],
			{ encoding: "utf-8" },
		);
		const loaded = JSON.parse(output) as { name: string; description: string; tools: Array<{ name: string }> };

		expect(loaded).toMatchObject({
			name: "root",
			description: "External workspace root",
			tools: [{ name: "dispatch_read" }],
		});
	});

	it("loads executable agent.ts default export as the canonical definition", async () => {
		const workspaceRoot = createTempWorkspace();
		const agentDir = join(workspaceRoot, "agents", "reviewer");
		const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "agent-definition.ts")).href;
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				`import { defineAgent, defineContextFile, defineModel, defineOpenAIProvider, defineSkill, defineTool } from ${JSON.stringify(dPiDefinitionUrl)};`,
				"",
				"export default defineAgent({",
				'\tdescription: "Executable reviewer",',
				'\troles: ["reviewer"],',
				"\tmodel: defineModel({",
				'\t\tid: "gpt-test",',
				'\t\tprovider: defineOpenAIProvider({ apiKey: "test-key" }),',
				"\t\tcontextWindow: 200000,",
				"\t}),",
				'\tskills: defineSkill({ dir: "./skills" }),',
				`\ttools: [${executableToolSource("dispatch_read")}],`,
				'\tcontextFiles: [defineContextFile({ type: "context", path: "./AGENTS.md" })],',
				"});",
				"",
			].join("\n"),
		);

		const loaded = await readLoadedAgentDefinitionFromTs(agentDir);

		expect(loaded).toMatchObject({
			name: "reviewer",
			agentDir,
			description: "Executable reviewer",
			roles: ["reviewer"],
			model: {
				id: "gpt-test",
				provider: {
					provider: "openai",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					apiKey: "test-key",
				},
				contextWindow: 200_000,
			},
			tools: [{ name: "dispatch_read" }],
			skills: { dir: "./skills" },
			contextFiles: [{ type: "context", path: "./AGENTS.md" }],
		});
	});
});
