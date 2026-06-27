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
	it("derives the agent name from the parent directory and returns file metadata", async () => {
		const parent = {
			description: "root",
			tools: [],
			sources: [],
			commands: [],
			middlewares: [],
			autoCompact: true,
		} as const;
		const agentFilePath = "/tmp/workspace/agents/reviewer/agent.ts";

		const loaded = await normalizeLoadedAgentDefinition(agentFilePath, {
			parent,
			description: "reviewer",
			tools: [executableTool("dispatch_read")],
			skills: { dir: "./skills" },
		});

		expect(loaded.name).toBe("reviewer");
		expect(loaded.agentDir).toBe("/tmp/workspace/agents/reviewer");
		expect(loaded.agentFilePath).toBe("/tmp/workspace/agents/reviewer/agent.ts");
		expect(loaded.description).toBe("reviewer");
		expect(loaded.parent).toBe(parent);
		expect(loaded.contextFiles).toEqual([]);
	});

	it("fills in defaults when definition is empty", async () => {
		const agentFilePath = "/tmp/workspace/agents/minimal/agent.ts";
		const loaded = await normalizeLoadedAgentDefinition(agentFilePath, {});
		expect(loaded.name).toBe("minimal");
		expect(loaded.tools).toEqual([]);
		expect(loaded.contextFiles).toEqual([]);
		expect(loaded.commands).toEqual([]);
		expect(loaded.sources).toEqual([]);
		expect(loaded.middlewares).toEqual([]);
		expect(loaded.autoCompact).toBe(true);
	});

	it("throws when the loaded definition is missing", async () => {
		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", undefined),
		).rejects.toThrow();
	});

	it("throws when the loaded definition is not an object", async () => {
		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", "reviewer"),
		).rejects.toThrow();
	});

	it("throws when contextFiles is provided in the definition", async () => {
		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [executableTool("dispatch_read")],
				skills: { dir: "./skills" },
				contextFiles: [{ type: "context", path: "./AGENTS.md" }],
			}),
		).rejects.toThrow(/contextFiles is not supported/);
	});

	it("throws when nested fields have invalid shapes", async () => {
		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [executableTool("dispatch_read")],
				skills: null,
			}),
		).rejects.toThrow();

		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [{ name: "dispatch_read" }],
				skills: { dir: "./skills" },
			}),
		).rejects.toThrow();
	});

	it("accepts one model definition and rejects invalid rich model shapes", async () => {
		const rich = await normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
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
			tools: [executableTool("dispatch_read")],
			skills: { dir: "./skills" },
		});

		expect(rich.model).toMatchObject({
			id: "gpt-test",
			provider: { provider: "openai", api: "openai-responses" },
			contextWindow: 200_000,
		});
		expect("models" in rich).toBe(false);
		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				model: { id: "bad", provider: "openai" },
				tools: [],
				skills: { dir: "./skills" },
			}),
		).rejects.toThrow();

		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				model: { id: "bad", provider: { provider: "openai", api: "openai-responses" }, contextWindow: 1 },
				tools: [],
				skills: { dir: "./skills" },
			}),
		).rejects.toThrow();

		await expect(
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				model: { id: "bad", provider: "stepfun", contextWindow: 1 },
				tools: [],
				skills: { dir: "./skills" },
			}),
		).rejects.toThrow();
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
				"  tools: [],",
				'  skills: { dir: "./skills" },',
				"  sources: [],",
				"  commands: [],",
				"  middlewares: [],",
				"  autoCompact: true,",
				"};",
				"export default {",
				"  parent,",
				'  description: "reviewer",',
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
				"};",
			].join("\n"),
		);

		const loaded = await loadAgentDefinitionFromFile(agentFilePath);

		expect(loaded.name).toBe("reviewer");
		expect(loaded.agentDir).toBe(join(workspaceRoot, "agents", "reviewer"));
		expect(loaded.agentFilePath).toBe(agentFilePath);
		expect(loaded.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(loaded.parent).toMatchObject({
			description: "root",
			tools: [],
			skills: { dir: "./skills" },
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
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				'import { defineAgent, defineSkill, defineTool } from "@sheason/d-pi";',
				"",
				"export default defineAgent({",
				'\tdescription: "External workspace root",',
				'\tskills: defineSkill({ dir: "./skills" }),',
				`\ttools: [${executableToolSource("dispatch_read")}],`,
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
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeFileSync(
			join(agentDir, "agent.ts"),
			[
				`import { defineAgent, defineModel, defineOpenAIProvider, defineSkill, defineTool } from ${JSON.stringify(dPiDefinitionUrl)};`,
				"",
				"export default defineAgent({",
				'\tdescription: "Executable reviewer",',
				"\tmodel: defineModel({",
				'\t\tid: "gpt-test",',
				'\t\tprovider: defineOpenAIProvider({ apiKey: "test-key" }),',
				"\t\tcontextWindow: 200000,",
				"\t}),",
				'\tskills: defineSkill({ dir: "./skills" }),',
				`\ttools: [${executableToolSource("dispatch_read")}],`,
				"});",
				"",
			].join("\n"),
		);

		const loaded = await readLoadedAgentDefinitionFromTs(agentDir);

		expect(loaded).toMatchObject({
			name: "reviewer",
			agentDir,
			description: "Executable reviewer",
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
		});
	});
});
