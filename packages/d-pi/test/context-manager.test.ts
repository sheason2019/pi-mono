import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentTsSource } from "../src/agent-config.ts";
import type { AgentContextFileDefinition, AgentSkillDefinition, AgentToolDefinition } from "../src/agent-definition.ts";
import type { LoadedAgentDefinition } from "../src/agent-loader.ts";
import { normalizeLoadedAgentDefinition } from "../src/agent-loader.ts";
import { DPiContextManager } from "../src/context/context-manager.ts";

let tempDir: string | undefined;

function createWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-context-manager-"));
	return tempDir;
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function createAgent(workspaceRoot: string, agentName: string, description: string): string {
	const agentDir = join(workspaceRoot, "agents", agentName);
	write(
		join(agentDir, "agent.ts"),
		buildAgentTsSource({
			name: agentName,
			parentName: undefined,
			description,
		}),
	);
	write(join(agentDir, "AGENTS.md"), `agent context for ${agentName}`);
	return agentDir;
}

function writeAgentDefinition(agentDir: string, source: string): void {
	write(join(agentDir, "agent.ts"), source);
}

function testTool(name: string): AgentToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: name }], details: {} };
		},
	};
}

async function createLoadedAgentDefinition(
	agentDir: string,
	options: {
		description?: string;
		skills?: AgentSkillDefinition;
		tools?: AgentToolDefinition[];
	} = {},
) {
	return normalizeLoadedAgentDefinition(join(agentDir, "agent.ts"), {
		description: options.description,
		tools: options.tools ?? [],
		skills: options.skills ?? { dir: "./skills" },
	});
}

function createInjectedAgentDefinition(
	agentDir: string,
	options: {
		description?: string;
		skills?: AgentSkillDefinition;
		tools?: AgentToolDefinition[];
		contextFiles?: AgentContextFileDefinition[];
	},
): LoadedAgentDefinition {
	const agentFilePath = join(agentDir, "agent.ts");
	return {
		name: "root",
		agentDir,
		agentFilePath,
		description: options.description,
		tools: options.tools ?? [],
		skills: options.skills ?? { dir: "./skills" },
		sources: [],
		contextFiles: options.contextFiles ?? [],
		commands: [],
		middlewares: [],
		autoCompact: true,
		disableDefaultTools: false,
	};
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("DPiContextManager", () => {
	it("places workspace context/*.md before the agent identity system prompt block", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		mkdirSync(join(workspaceRoot, "context"), { recursive: true });
		writeFileSync(join(workspaceRoot, "context", "shared.md"), "workspace shared context");

		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: agentDir,
			agentDefinition: await createLoadedAgentDefinition(agentDir, { description: "Root agent identity." }),
		});

		const parts = manager.loadSystemPromptParts();
		const workspaceIndex = parts.findIndex((p) => p.includes("workspace shared context"));
		const identityIndex = parts.findIndex((part) => part.includes("## Agent identity"));

		expect(workspaceIndex).toBe(0);
		expect(identityIndex).toBeGreaterThan(workspaceIndex);
		expect(parts[identityIndex]).toContain("Root agent identity.");
	});

	it("uses the injected agent definition identity when reloaded", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "reviewer", "Original identity.");
		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "reviewer",
			agentDir,
			cwd: agentDir,
			agentDefinition: await createLoadedAgentDefinition(agentDir, { description: "Original identity." }),
		});

		expect(manager.loadSystemPromptParts().join("\n")).toContain("Original identity.");

		write(
			join(agentDir, "agent.ts"),
			buildAgentTsSource({
				name: "reviewer",
				parentName: undefined,
				description: "Reloaded identity.",
			}),
		);

		manager.reload();

		const reloadedParts = manager.loadSystemPromptParts().join("\n");
		expect(reloadedParts).toContain("Original identity.");
		expect(reloadedParts).not.toContain("Reloaded identity.");
	});

	it("includes workspace AGENTS.md before local project and agent context", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const projectDir = join(workspaceRoot, "project");
		write(join(workspaceRoot, "AGENTS.md"), "workspace project context");
		write(join(projectDir, "AGENTS.md"), "local project context");

		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: projectDir,
			agentDefinition: await createLoadedAgentDefinition(agentDir, { description: "Root agent identity." }),
		});

		expect(manager.loadContextFiles()).toEqual([
			{ path: join(workspaceRoot, "AGENTS.md"), content: "workspace project context" },
			{ path: join(projectDir, "AGENTS.md"), content: "local project context" },
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
	});

	it("surfaces workspace skills without a coding-agent resource loader", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		mkdirSync(join(workspaceRoot, "skills"), { recursive: true });

		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: agentDir,
			agentDefinition: await createLoadedAgentDefinition(agentDir, { description: "Root agent identity." }),
		});

		expect(manager.loadSkills()).toEqual([join(workspaceRoot, "skills")]);
	});

	it("loads convention-based context files from context/ directory and AGENTS.md, append-system files, and skills", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const customAppendPath = join(agentDir, "context", "extra.md");
		const customSkillsDir = join(agentDir, "custom-skills");
		write(customAppendPath, "custom append");
		mkdirSync(customSkillsDir, { recursive: true });
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeAgentDefinition(
			agentDir,
			[
				'import { createDispatchReadTool, defineAgent, defineSkill } from "@sheason/d-pi";',
				"",
				"export default defineAgent({",
				'\tdescription: "Root agent identity.",',
				'\tskills: defineSkill({ dir: "./custom-skills" }),',
				"\ttools: [createDispatchReadTool()],",
				"});",
				"",
			].join("\n"),
		);

		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: agentDir,
			agentDefinition: await createLoadedAgentDefinition(agentDir, {
				description: "Root agent identity.",
				skills: { dir: "./custom-skills" },
				tools: [testTool("dispatch_read")],
			}),
		});

		expect(manager.loadContextFiles()).toEqual([
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
		const systemPromptParts = manager.loadSystemPromptParts();
		expect(systemPromptParts).toEqual(expect.arrayContaining(["custom append"]));
		expect(manager.loadSkills()).toEqual([customSkillsDir]);
	});

	it("uses an injected loaded agent definition for runtime context resources", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const customContextPath = join(agentDir, "custom", "CONTEXT.md");
		const customAppendPath = join(agentDir, "custom", "APPEND.md");
		const customSkillsDir = join(agentDir, "custom-skills");
		write(customContextPath, "custom context");
		write(customAppendPath, "custom append");
		mkdirSync(customSkillsDir, { recursive: true });
		const agentDefinition = createInjectedAgentDefinition(agentDir, {
			description: "Injected identity.",
			skills: { dir: "./custom-skills" },
			tools: [testTool("dispatch_read")],
			contextFiles: [
				{ type: "context", path: "./custom/CONTEXT.md" },
				{ type: "context", path: "./AGENTS.md" },
				{ type: "append_system", path: "./custom/APPEND.md" },
			],
		});
		writeAgentDefinition(
			agentDir,
			buildAgentTsSource({
				name: "root",
				parentName: undefined,
				description: "Disk identity should not be read.",
			}),
		);

		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: agentDir,
			agentDefinition,
		});

		expect(manager.loadContextFiles()).toEqual([
			{ path: customContextPath, content: "custom context" },
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
		expect(manager.loadSystemPromptParts()).toEqual(expect.arrayContaining(["custom append"]));
		expect(manager.loadSkills()).toEqual([customSkillsDir]);
	});

	it("uses injected resource definitions without parsing source text", async () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const customContextPath = join(agentDir, "custom", "CONTEXT.md");
		const customAppendPath = join(agentDir, "custom", "APPEND.md");
		const customSkillsDir = join(agentDir, "custom-skills");
		write(customContextPath, "custom context");
		write(customAppendPath, "custom append");
		mkdirSync(customSkillsDir, { recursive: true });
		const manager = new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: agentDir,
			agentDefinition: createInjectedAgentDefinition(agentDir, {
				description: "Root agent identity.",
				skills: { dir: "./custom-skills" },
				tools: [testTool("dispatch_read")],
				contextFiles: [
					{ type: "context", path: "./custom/CONTEXT.md" },
					{ type: "context", path: "./AGENTS.md" },
					{ type: "append_system", path: "./custom/APPEND.md" },
				],
			}),
		});

		expect(manager.loadContextFiles()).toEqual([
			{ path: customContextPath, content: "custom context" },
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
		expect(manager.loadSystemPromptParts()).toEqual(expect.arrayContaining(["custom append"]));
		expect(manager.loadSkills()).toEqual([customSkillsDir]);
	});

	it("does not load convention-based agent resources when no loaded agent definition is provided", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeAgentDefinition(
			agentDir,
			['import { defineAgent } from "@sheason/d-pi";', "", "export default defineAgent({", "});", ""].join("\n"),
		);
		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir });

		expect(manager.loadContextFiles()).toEqual([]);
		expect(manager.loadSystemPromptParts()).not.toContain("agent context for root");
		expect(manager.loadSkills()).toEqual([]);
	});
});
