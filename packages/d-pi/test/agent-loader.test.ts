import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentDefinitionFromFile, normalizeLoadedAgentDefinition } from "../src/agent-loader.ts";

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
			tools: [{ name: "dispatch_read" }],
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
				tools: [{ name: "dispatch_read" }],
				skills: null,
				contextFiles: [],
			}),
		).toThrow(/skills.dir must be a string/i);

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/reviewer/agent.ts", {
				tools: [{ name: "dispatch_read" }],
				skills: { dir: "./skills" },
				contextFiles: [{ type: "invalid", path: "./AGENTS.md" }],
			}),
		).toThrow(/contextFiles.*type/i);
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
				'  tools: [{ name: "dispatch_read" }],',
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
