import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceContext } from "../types.ts";

const DPI_DIR = ".dpi";
const CONFIG_FILE = "config.json";
const AGENTS_DIR = "agents";
const SKILLS_DIR = "skills";
const EXTENSIONS_DIR = "extensions";
const APPEND_SYSTEM_MD = "APPEND_SYSTEM.md";

/**
 * Check if the given directory is a d-pi workspace root (contains .dpi/).
 */
export function isWorkspaceRoot(dir: string): boolean {
	return existsSync(join(resolve(dir), DPI_DIR));
}

/**
 * Validate and load workspace config from .dpi/config.json.
 * Throws if the config is missing or invalid.
 */
export function validateWorkspace(workspaceRoot: string): WorkspaceConfig {
	const configPath = join(workspaceRoot, DPI_DIR, CONFIG_FILE);
	if (!existsSync(configPath)) {
		throw new Error(`Invalid workspace: missing ${DPI_DIR}/${CONFIG_FILE}`);
	}
	try {
		let raw = readFileSync(configPath, "utf-8");
		// Strip single-line comments (// ...) to allow documented config templates
		raw = raw.replace(/\/\/.*$/gm, "");
		const parsed = JSON.parse(raw);
		if (parsed.version !== 1) {
			throw new Error(`Unsupported workspace version: ${parsed.version}`);
		}
		return parsed as WorkspaceConfig;
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new Error(`Invalid workspace config: ${configPath} is not valid JSON`);
		}
		throw err;
	}
}

/**
 * Load workspace context: APPEND_SYSTEM.md content, skill paths, extension paths.
 */
export function loadWorkspaceContext(workspaceRoot: string): WorkspaceContext {
	const resolved = resolve(workspaceRoot);

	// Read APPEND_SYSTEM.md if present
	const appendSystemPath = join(resolved, APPEND_SYSTEM_MD);
	let appendSystemPrompt: string | undefined;
	if (existsSync(appendSystemPath)) {
		appendSystemPrompt = readFileSync(appendSystemPath, "utf-8");
	}

	// Collect skill paths
	const additionalSkillPaths: string[] = [];
	const skillsDir = join(resolved, SKILLS_DIR);
	if (existsSync(skillsDir)) {
		additionalSkillPaths.push(skillsDir);
	}

	// Collect extension paths
	const additionalExtensionPaths: string[] = [];
	const extensionsDir = join(resolved, EXTENSIONS_DIR);
	if (existsSync(extensionsDir)) {
		additionalExtensionPaths.push(extensionsDir);
	}

	return {
		workspaceRoot: resolved,
		appendSystemPrompt,
		additionalSkillPaths,
		additionalExtensionPaths,
	};
}

/**
 * Initialize a d-pi workspace in the given directory.
 * Creates .dpi/config.json, agents/, agents/root/, and context file templates.
 */
export function initWorkspace(dir: string): void {
	const resolved = resolve(dir);

	// Check if already a workspace
	if (isWorkspaceRoot(resolved)) {
		throw new Error(`Already a d-pi workspace: ${resolved}`);
	}

	// Create .dpi/
	const dpiDir = join(resolved, DPI_DIR);
	mkdirSync(dpiDir, { recursive: true });

	// Write .dpi/config.json (with documentation comments)
	writeFileSync(
		join(dpiDir, CONFIG_FILE),
		`{
\t"version": 1,
\t// "tools": ["tool_name"],        // Allowlist: only these tools are available to agents (omit = all tools)
\t// "excludeTools": ["tool_name"], // Denylist: these tools are excluded for all agents (applied after allowlist)
\t// "defaultModel": "anthropic/claude-sonnet-4" // Default model for all agents
}
`,
	);

	// Create agents/ and agents/root/
	const agentsDir = join(resolved, AGENTS_DIR);
	const rootAgentDir = join(agentsDir, "root");
	mkdirSync(rootAgentDir, { recursive: true });

	// Write agents/root/agent.json (with documentation comments)
	writeFileSync(
		join(rootAgentDir, "agent.json"),
		`{
\t"name": "root",
\t"parentName": null,
\t// "model": "anthropic/claude-sonnet-4", // Override model for this agent
\t// "tools": ["tool_name"],               // Allowlist: only these tools available (overrides workspace config)
\t// "excludeTools": ["tool_name"]         // Denylist: exclude these tools (overrides workspace config)
}
`,
	);

	// --- Workspace-level context files ---

	// AGENTS.md: shared context injected into all agents
	const agentsMdPath = join(resolved, "AGENTS.md");
	if (!existsSync(agentsMdPath)) {
		writeFileSync(
			agentsMdPath,
			`# Project Context

This file is shared across all agents in the workspace.
Add project-specific instructions, conventions, and guidelines here.
`,
		);
	}

	// APPEND_SYSTEM.md: shared content appended to all agents' system prompts
	const appendSystemMdPath = join(resolved, APPEND_SYSTEM_MD);
	if (!existsSync(appendSystemMdPath)) {
		writeFileSync(
			appendSystemMdPath,
			`# Workspace System Prompt (Append)

Content here is appended to every agent's system prompt.
Use this for shared rules, safety guidelines, or conventions
that all agents should follow.
`,
		);
	}

	// --- Agent-level context files (root agent) ---

	// agents/root/AGENTS.md: root-agent-specific context
	const rootAgentsMdPath = join(rootAgentDir, "AGENTS.md");
	if (!existsSync(rootAgentsMdPath)) {
		writeFileSync(
			rootAgentsMdPath,
			`# Root Agent Context

This file is specific to the root agent.
Workspace-level context from AGENTS.md in the workspace root
is also loaded automatically.
`,
		);
	}

	// agents/root/.pi/APPEND_SYSTEM.md: root-agent-specific system prompt append
	const rootPiDir = join(rootAgentDir, ".pi");
	mkdirSync(rootPiDir, { recursive: true });
	const rootAppendSystemPath = join(rootPiDir, APPEND_SYSTEM_MD);
	if (!existsSync(rootAppendSystemPath)) {
		writeFileSync(
			rootAppendSystemPath,
			`# Root Agent System Prompt (Append)

Content here is appended to the root agent's system prompt,
in addition to the workspace-level APPEND_SYSTEM.md.
`,
		);
	}
}
