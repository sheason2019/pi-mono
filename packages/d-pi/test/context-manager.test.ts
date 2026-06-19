import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentTsSource } from "../src/agent-config.ts";
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
	write(join(agentDir, ".pi", "APPEND_SYSTEM.md"), `agent append for ${agentName}`);
	return agentDir;
}

function writeAgentDefinition(agentDir: string, source: string): void {
	write(join(agentDir, "agent.ts"), source);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("DPiContextManager", () => {
	it("places workspace APPEND_SYSTEM.md before the agent identity system prompt block", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		write(join(workspaceRoot, "APPEND_SYSTEM.md"), "workspace append block");

		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir });

		const parts = manager.loadSystemPromptParts();
		const workspaceIndex = parts.indexOf("workspace append block");
		const identityIndex = parts.findIndex((part) => part.includes("## Agent identity"));

		expect(workspaceIndex).toBe(0);
		expect(identityIndex).toBeGreaterThan(workspaceIndex);
		expect(parts[identityIndex]).toContain("Root agent identity.");
	});

	it("re-reads agent.ts identity when reloaded", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "reviewer", "Original identity.");
		const manager = new DPiContextManager({ workspaceRoot, agentName: "reviewer", agentDir, cwd: agentDir });

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
		expect(reloadedParts).toContain("Reloaded identity.");
		expect(reloadedParts).not.toContain("Original identity.");
	});

	it("includes workspace and team-template AGENTS.md before local project and agent context", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const projectDir = join(workspaceRoot, "project");
		write(join(workspaceRoot, "AGENTS.md"), "workspace project context");
		write(join(workspaceRoot, "team-template", "AGENTS.md"), "team-template context");
		write(join(projectDir, "AGENTS.md"), "local project context");

		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: projectDir });

		expect(manager.loadContextFiles()).toEqual([
			{ path: join(workspaceRoot, "AGENTS.md"), content: "workspace project context" },
			{ path: join(workspaceRoot, "team-template", "AGENTS.md"), content: "team-template context" },
			{ path: join(projectDir, "AGENTS.md"), content: "local project context" },
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
	});

	it("surfaces workspace and team-template skills and extensions without a coding-agent resource loader", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		mkdirSync(join(workspaceRoot, "team-template", "skills"), { recursive: true });
		mkdirSync(join(workspaceRoot, "skills"), { recursive: true });
		write(join(workspaceRoot, "team-template", "extensions", "team.js"), "export default function team() {}");
		write(join(workspaceRoot, "extensions", "workspace.ts"), "export default function workspace() {}");

		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir });

		expect(manager.loadSkills()).toEqual([
			join(workspaceRoot, "team-template", "skills"),
			join(workspaceRoot, "skills"),
		]);
		expect(manager.loadExtensions()).toEqual([
			join(workspaceRoot, "team-template", "extensions", "team.js"),
			join(workspaceRoot, "extensions", "workspace.ts"),
		]);
	});

	it("loads agent.ts configured context files, append-system files, and skills before default agent resources", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const customContextPath = join(agentDir, "custom", "CONTEXT.md");
		const customAppendPath = join(agentDir, "custom", "APPEND.md");
		const customSkillsDir = join(agentDir, "custom-skills");
		const defaultSkillsDir = join(agentDir, "skills");
		write(customContextPath, "custom context");
		write(customAppendPath, "custom append");
		mkdirSync(customSkillsDir, { recursive: true });
		mkdirSync(defaultSkillsDir, { recursive: true });
		writeAgentDefinition(
			agentDir,
			[
				'import { defineAgent, defineContextFile, defineSkill, defineTool } from "@sheason/d-pi";',
				"",
				"export default defineAgent({",
				'\tdescription: "Root agent identity.",',
				'\tskills: defineSkill({ dir: "./custom-skills" }),',
				'\ttools: [defineTool({ name: "dispatch_read" })],',
				"\tcontextFiles: [",
				'\t\tdefineContextFile({ type: "context", path: "./custom/CONTEXT.md" }),',
				'\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),',
				'\t\tdefineContextFile({ type: "append_system", path: "./custom/APPEND.md" }),',
				'\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),',
				"\t],",
				"});",
				"",
			].join("\n"),
		);

		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir });

		expect(manager.loadContextFiles()).toEqual([
			{ path: customContextPath, content: "custom context" },
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
		const systemPromptParts = manager.loadSystemPromptParts();
		expect(systemPromptParts).toEqual(expect.arrayContaining(["custom append", "agent append for root"]));
		expect(systemPromptParts.indexOf("custom append")).toBeLessThan(
			systemPromptParts.indexOf("agent append for root"),
		);
		expect(systemPromptParts.filter((part) => part === "agent append for root")).toHaveLength(1);
		expect(manager.loadSkills()).toEqual([customSkillsDir, defaultSkillsDir]);
	});

	it("statically parses multiline agent.ts resources with single quotes and ignores commented calls", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		const customContextPath = join(agentDir, "custom", "CONTEXT.md");
		const customAppendPath = join(agentDir, "custom", "APPEND.md");
		const commentedContextPath = join(agentDir, "commented", "SHOULD_NOT_LOAD.md");
		const customSkillsDir = join(agentDir, "custom-skills");
		write(customContextPath, "custom context");
		write(customAppendPath, "custom append");
		write(commentedContextPath, "commented context");
		mkdirSync(customSkillsDir, { recursive: true });
		writeAgentDefinition(
			agentDir,
			[
				'import { defineAgent, defineContextFile, defineSkill, defineTool } from "@sheason/d-pi";',
				"",
				'// defineContextFile({ type: "context", path: "./commented/SHOULD_NOT_LOAD.md" })',
				"export default defineAgent({",
				"\tdescription: 'Root agent identity.',",
				"\tskills: defineSkill({",
				"\t\tdir: './custom-skills',",
				"\t}),",
				"\ttools: [",
				"\t\tdefineTool({ name: 'dispatch_read' }),",
				"\t],",
				"\tcontextFiles: [",
				"\t\tdefineContextFile({",
				"\t\t\tpath: './custom/CONTEXT.md',",
				"\t\t\ttype: 'context',",
				"\t\t}),",
				"\t\tdefineContextFile({",
				"\t\t\ttype: 'context',",
				"\t\t\tpath: './AGENTS.md',",
				"\t\t}),",
				"\t\tdefineContextFile({",
				"\t\t\ttype: 'append_system',",
				"\t\t\tpath: './custom/APPEND.md',",
				"\t\t}),",
				"\t],",
				"});",
				"",
			].join("\n"),
		);

		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir });

		expect(manager.loadContextFiles()).toEqual([
			{ path: customContextPath, content: "custom context" },
			{ path: join(agentDir, "AGENTS.md"), content: "agent context for root" },
		]);
		expect(manager.loadSystemPromptParts()).toEqual(expect.arrayContaining(["custom append"]));
		expect(manager.loadSkills()).toEqual([customSkillsDir]);
	});

	it("throws instead of falling back to default resources when agent.ts exists but is invalid", () => {
		const workspaceRoot = createWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Root agent identity.");
		writeAgentDefinition(
			agentDir,
			[
				'import { defineAgent } from "@sheason/d-pi";',
				"",
				"export default defineAgent({",
				"\ttools: [],",
				"});",
				"",
			].join("\n"),
		);
		const manager = new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir });

		expect(() => manager.loadContextFiles()).toThrow(join(agentDir, "agent.ts"));
	});
});
