import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceContext } from "../types.ts";

const DPI_DIR = ".dpi";
const CONFIG_FILE = "config.json";
const AGENTS_DIR = "agents";
const GROUP_ARCHITECTURE_DIR = "group-architecture";
const SKILLS_DIR = "skills";
const EXTENSIONS_DIR = "extensions";
const ROLES_DIR = "roles";
const APPEND_SYSTEM_MD = "APPEND_SYSTEM.md";
const AGENTS_MD = "AGENTS.md";

export interface LoadWorkspaceContextOptions {
	agentName?: string;
	roles?: string[];
}

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
		// Strict JSON parse. The init template (and every agent config) is
		// emitted as canonical JSON via JSON.stringify, so no comment-stripping
		// workaround is needed. If a user adds a hand-written config with `//`
		// or trailing commas, JSON.parse will surface the SyntaxError.
		const raw = readFileSync(configPath, "utf-8");
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
export function loadWorkspaceContext(
	workspaceRoot: string,
	options: LoadWorkspaceContextOptions = {},
): WorkspaceContext {
	const resolved = resolve(workspaceRoot);

	// Read APPEND_SYSTEM.md if present
	const appendSystemPath = join(resolved, APPEND_SYSTEM_MD);
	let appendSystemPrompt: string | undefined;
	if (existsSync(appendSystemPath)) {
		appendSystemPrompt = readFileSync(appendSystemPath, "utf-8");
	}

	const additionalAgentsFiles: Array<{ path: string; content: string }> = [];
	const additionalSkillPaths: string[] = [];
	const additionalExtensionPaths: string[] = [];

	collectGroupArchitectureContext(resolved, options, additionalAgentsFiles, additionalSkillPaths, additionalExtensionPaths);
	pushIfExists(additionalSkillPaths, join(resolved, SKILLS_DIR));
	pushExtensionEntriesIfExists(additionalExtensionPaths, join(resolved, EXTENSIONS_DIR));

	return {
		workspaceRoot: resolved,
		appendSystemPrompt,
		additionalAgentsFiles,
		additionalSkillPaths,
		additionalExtensionPaths,
	};
}

function collectGroupArchitectureContext(
	workspaceRoot: string,
	options: LoadWorkspaceContextOptions,
	additionalAgentsFiles: Array<{ path: string; content: string }>,
	additionalSkillPaths: string[],
	additionalExtensionPaths: string[],
): void {
	const architectureDir = join(workspaceRoot, GROUP_ARCHITECTURE_DIR);
	if (!existsSync(architectureDir)) {
		return;
	}
	pushAgentsFileIfExists(additionalAgentsFiles, join(architectureDir, AGENTS_MD));
	pushIfExists(additionalSkillPaths, join(architectureDir, SKILLS_DIR));
	pushExtensionEntriesIfExists(additionalExtensionPaths, join(architectureDir, EXTENSIONS_DIR));

	for (const role of getEffectiveRoles(options)) {
		const roleDir = join(architectureDir, ROLES_DIR, role.name);
		if (!existsSync(roleDir)) {
			if (role.implicit) {
				continue;
			}
			throw new Error(`Unknown agent role "${role.name}": ${roleDir}`);
		}
		pushAgentsFileIfExists(additionalAgentsFiles, join(roleDir, AGENTS_MD));
		pushIfExists(additionalSkillPaths, join(roleDir, SKILLS_DIR));
		pushExtensionEntriesIfExists(additionalExtensionPaths, join(roleDir, EXTENSIONS_DIR));
	}
}

function getEffectiveRoles(options: LoadWorkspaceContextOptions): Array<{ name: string; implicit: boolean }> {
	const roles = options.roles ?? [];
	if (options.agentName !== "root") {
		return roles.map((name) => ({ name, implicit: false }));
	}
	return [
		{ name: "root", implicit: !roles.includes("root") },
		...roles.filter((role) => role !== "root").map((name) => ({ name, implicit: false })),
	];
}

function pushIfExists(target: string[], path: string): void {
	if (existsSync(path)) {
		target.push(path);
	}
}

function pushExtensionEntriesIfExists(target: string[], path: string): void {
	if (!existsSync(path)) {
		return;
	}
	for (const entry of discoverExtensionEntries(path)) {
		target.push(entry);
	}
}

function discoverExtensionEntries(path: string): string[] {
	const stats = statSync(path);
	if (!stats.isDirectory()) {
		return [path];
	}
	const manifestEntries = readPiExtensionManifest(path);
	if (manifestEntries.length > 0) {
		return manifestEntries;
	}
	const indexTs = join(path, "index.ts");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	const indexJs = join(path, "index.js");
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	const entries: string[] = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const entryPath = join(path, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			entries.push(entryPath);
			continue;
		}
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			entries.push(...discoverExtensionEntries(entryPath));
		}
	}
	return entries;
}

function readPiExtensionManifest(dir: string): string[] {
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return [];
	}
	const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: string[] } };
	return (parsed.pi?.extensions ?? []).map((entry) => join(dir, entry)).filter((entry) => existsSync(entry));
}

function isExtensionFile(filename: string): boolean {
	return filename.endsWith(".ts") || filename.endsWith(".js");
}

function pushAgentsFileIfExists(target: Array<{ path: string; content: string }>, path: string): void {
	if (existsSync(path)) {
		target.push({ path, content: readFileSync(path, "utf-8") });
	}
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

	// Write .dpi/config.json — strict JSON, no comments.
	// Optional keys (includeTools, excludeTools, defaultModel) are documented in
	// the workspace-level AGENTS.md below.
	writeFileSync(
		join(dpiDir, CONFIG_FILE),
		`{
\t"version": 1
}
`,
	);

	// Create agents/ and agents/root/
	const agentsDir = join(resolved, AGENTS_DIR);
	const rootAgentDir = join(agentsDir, "root");
	mkdirSync(rootAgentDir, { recursive: true });

	// Write agents/root/agent.json — strict JSON, no comments.
	// Optional keys (model, includeTools, excludeTools, roles, sessionId) are
	// documented in the workspace-level AGENTS.md below.
	writeFileSync(
		join(rootAgentDir, "agent.json"),
		`{
\t"name": "root",
\t"parentName": null
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

## Workspace Configuration (\`.dpi/config.json\`)

Strict JSON — no comments, no trailing commas. Top-level keys:

- \`version\` (required, must be \`1\`)
- \`defaultModel\` (optional): e.g. \`"anthropic/claude-sonnet-4"\` — default model for all agents.
- \`includeTools\` (optional): allowlist of tool names available to every agent. Omit to allow all.
- \`excludeTools\` (optional): denylist applied after the allowlist.

## Agent Configuration (\`agents/<name>/agent.json\`)

Strict JSON. Top-level keys:

- \`name\` (required): unique agent name.
- \`parentName\` (required, may be \`null\`): name of the parent agent.
- \`model\` (optional): overrides the workspace default model for this agent.
- \`roles\` (optional): array of role names — see \`.dpi/group-architecture/roles/\`.
- \`includeTools\` (optional): allowlist that overrides the workspace allowlist.
- \`excludeTools\` (optional): denylist that overrides the workspace denylist.
- \`sessionId\` (optional, managed by the hub): used to resume sessions across restarts.
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
