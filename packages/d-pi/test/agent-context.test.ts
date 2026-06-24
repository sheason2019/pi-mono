import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadAgentRuntimeContextFiles,
	loadAgentRuntimeResources,
	loadAgentRuntimeSystemPromptBlocks,
} from "../src/agent-context.ts";
import type { LoadedAgentDefinition } from "../src/agent-loader.ts";

let tempDir: string | undefined;

function createLoadedAgentDefinition(agentDir: string): LoadedAgentDefinition {
	return {
		name: "reviewer",
		agentDir,
		agentFilePath: join(agentDir, "agent.ts"),
		description: "reviewer",
		roles: ["reviewer"],
		tools: [],
		skills: { dir: "./skills" },
		contextFiles: [
			{ type: "context", path: "./docs/AGENTS.md" },
			{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
			{ type: "context", path: "./missing.md" },
			{ type: "append_system", path: "./.pi/MISSING_APPEND.md" },
			{ type: "append_system", path: "./notes/system.txt" },
		],
		autoCompact: true,
	};
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("agent context runtime helpers", () => {
	it("separates context files and append-system blocks while resolving paths from agentDir", () => {
		tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-context-"));
		const agentDir = join(tempDir, "agents", "reviewer");
		mkdirSync(join(agentDir, "docs"), { recursive: true });
		mkdirSync(join(agentDir, ".pi"), { recursive: true });
		mkdirSync(join(agentDir, "notes"), { recursive: true });
		writeFileSync(join(agentDir, "docs", "AGENTS.md"), "agent context");
		writeFileSync(join(agentDir, ".pi", "APPEND_SYSTEM.md"), "append block 1");
		writeFileSync(join(agentDir, "notes", "system.txt"), "append block 2");

		const agent = createLoadedAgentDefinition(agentDir);

		expect(loadAgentRuntimeContextFiles(agent)).toEqual([
			{
				path: join(agentDir, "docs", "AGENTS.md"),
				content: "agent context",
			},
		]);
		expect(loadAgentRuntimeSystemPromptBlocks(agent)).toEqual(["append block 1", "append block 2"]);
		expect(loadAgentRuntimeResources(agent)).toEqual({
			agentsFiles: [
				{
					path: join(agentDir, "docs", "AGENTS.md"),
					content: "agent context",
				},
			],
			appendSystemPrompt: ["append block 1", "append block 2"],
		});
	});

	it("skips missing files", () => {
		tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-context-"));
		const agentDir = join(tempDir, "agents", "reviewer");
		mkdirSync(agentDir, { recursive: true });

		const agent = createLoadedAgentDefinition(agentDir);

		expect(loadAgentRuntimeContextFiles(agent)).toEqual([]);
		expect(loadAgentRuntimeSystemPromptBlocks(agent)).toEqual([]);
		expect(loadAgentRuntimeResources(agent)).toEqual({
			agentsFiles: [],
			appendSystemPrompt: [],
		});
	});

	it("rejects context file paths that escape agentDir", () => {
		tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-context-"));
		const agentDir = join(tempDir, "agents", "reviewer");
		mkdirSync(agentDir, { recursive: true });

		const relativeEscape: LoadedAgentDefinition = {
			...createLoadedAgentDefinition(agentDir),
			contextFiles: [{ type: "context", path: "../secret.md" }],
		};
		expect(() => loadAgentRuntimeResources(relativeEscape)).toThrow(/must stay inside agent directory/);

		const absoluteEscape: LoadedAgentDefinition = {
			...createLoadedAgentDefinition(agentDir),
			contextFiles: [{ type: "append_system", path: resolve(tempDir, "secret.md") }],
		};
		expect(() => loadAgentRuntimeResources(absoluteEscape)).toThrow(/must stay inside agent directory/);
	});

	it("throws when a configured context file path is unreadable as a file", () => {
		tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-context-"));
		const agentDir = join(tempDir, "agents", "reviewer");
		mkdirSync(join(agentDir, "docs"), { recursive: true });
		const agent: LoadedAgentDefinition = {
			...createLoadedAgentDefinition(agentDir),
			contextFiles: [{ type: "context", path: "./docs" }],
		};

		expect(() => loadAgentRuntimeResources(agent)).toThrow(/Failed to read context file/);
	});
});
