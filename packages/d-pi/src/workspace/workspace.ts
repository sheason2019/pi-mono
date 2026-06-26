import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentTsSource } from "../agent-config.ts";
import type { WorkspaceContext } from "../types.ts";

const DPI_DIR = ".dpi";
const CONFIG_FILE = "config.json";
const AGENTS_DIR = "agents";
const TEAM_TEMPLATE_DIR = "team-template";
const SKILLS_DIR = "skills";
const TUI_COMPONENTS_DIR = "tui-components";
const APPEND_SYSTEM_MD = "APPEND_SYSTEM.md";
const AGENTS_MD = "AGENTS.md";
const D_PI_PACKAGE_NAME = "@sheason/d-pi";

function dPiPackageRoot(): string {
	return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function packageNameFromDirectory(dir: string): string {
	const basename = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "dpi-workspace";
	const normalized = basename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	return normalized || "dpi-workspace";
}

function writeWorkspacePackageJson(workspaceRoot: string): void {
	const packageJsonPath = join(workspaceRoot, "package.json");
	const packageRoot = dPiPackageRoot();
	const dependencyPath = relative(workspaceRoot, packageRoot) || ".";
	const dependencySpec = `file:${dependencyPath.startsWith(".") ? dependencyPath : `./${dependencyPath}`}`;
	const nextPackageJson = {
		name: packageNameFromDirectory(workspaceRoot),
		private: true,
		type: "module",
		dependencies: {
			[D_PI_PACKAGE_NAME]: dependencySpec,
		},
	};

	if (!existsSync(packageJsonPath)) {
		writeFileSync(packageJsonPath, `${JSON.stringify(nextPackageJson, null, "\t")}\n`);
		return;
	}

	const current = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
	const dependencies =
		typeof current.dependencies === "object" && current.dependencies !== null
			? (current.dependencies as Record<string, unknown>)
			: {};
	writeFileSync(
		packageJsonPath,
		`${JSON.stringify(
			{
				...current,
				private: true,
				type: "module",
				dependencies: {
					...dependencies,
					[D_PI_PACKAGE_NAME]: dependencySpec,
				},
			},
			null,
			"\t",
		)}\n`,
	);
}

function linkDPiPackageIntoWorkspace(workspaceRoot: string): void {
	const scopeDir = join(workspaceRoot, "node_modules", "@sheason");
	const linkPath = join(scopeDir, "d-pi");
	const packageRoot = dPiPackageRoot();
	mkdirSync(scopeDir, { recursive: true });
	if (existsSync(linkPath)) {
		const stat = lstatSync(linkPath);
		if (stat.isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === packageRoot) {
			return;
		}
		throw new Error(`${linkPath} already exists and is not linked to ${packageRoot}`);
	}
	symlinkSync(packageRoot, linkPath, "dir");
}

export interface LoadWorkspaceContextOptions {
	agentName?: string;
	roles?: string[];
}

export function isWorkspaceRoot(dir: string): boolean {
	return existsSync(join(resolve(dir), DPI_DIR));
}

export function loadWorkspaceContext(
	workspaceRoot: string,
	options: LoadWorkspaceContextOptions = {},
): WorkspaceContext {
	const resolved = resolve(workspaceRoot);

	const appendSystemPath = join(resolved, APPEND_SYSTEM_MD);
	let appendSystemPrompt: string | undefined;
	if (existsSync(appendSystemPath)) {
		appendSystemPrompt = readFileSync(appendSystemPath, "utf-8");
	}

	const additionalAgentsFiles: Array<{ path: string; content: string }> = [];
	const additionalSkillPaths: string[] = [];

	collectTeamTemplateContext(resolved, options, additionalAgentsFiles, additionalSkillPaths);
	pushIfExists(additionalSkillPaths, join(resolved, SKILLS_DIR));

	return {
		workspaceRoot: resolved,
		appendSystemPrompt,
		additionalAgentsFiles,
		additionalSkillPaths,
	};
}

function collectTeamTemplateContext(
	workspaceRoot: string,
	_options: LoadWorkspaceContextOptions,
	additionalAgentsFiles: Array<{ path: string; content: string }>,
	additionalSkillPaths: string[],
): void {
	const architectureDir = join(workspaceRoot, TEAM_TEMPLATE_DIR);
	if (!existsSync(architectureDir)) {
		return;
	}
	pushAgentsFileIfExists(additionalAgentsFiles, join(architectureDir, AGENTS_MD));
	pushIfExists(additionalSkillPaths, join(architectureDir, SKILLS_DIR));
}

function pushIfExists(target: string[], path: string): void {
	if (existsSync(path)) {
		target.push(path);
	}
}

function pushAgentsFileIfExists(target: Array<{ path: string; content: string }>, path: string): void {
	if (existsSync(path)) {
		target.push({ path, content: readFileSync(path, "utf-8") });
	}
}

export function initWorkspace(dir: string): void {
	const resolved = resolve(dir);

	if (isWorkspaceRoot(resolved)) {
		throw new Error(`Already a d-pi workspace: ${resolved}`);
	}

	mkdirSync(resolved, { recursive: true });
	writeWorkspacePackageJson(resolved);
	linkDPiPackageIntoWorkspace(resolved);

	const dpiDir = join(resolved, DPI_DIR);
	mkdirSync(dpiDir, { recursive: true });

	writeFileSync(join(dpiDir, CONFIG_FILE), "{}\n");

	const agentsDir = join(resolved, AGENTS_DIR);
	const rootAgentDir = join(agentsDir, "root");
	mkdirSync(rootAgentDir, { recursive: true });
	const tuiComponentsDir = join(resolved, TUI_COMPONENTS_DIR);
	mkdirSync(tuiComponentsDir, { recursive: true });

	writeFileSync(
		join(rootAgentDir, "agent.ts"),
		buildAgentTsSource({
			name: "root",
			parentName: undefined,
			description: "",
		}),
	);

	const agentsMdPath = join(resolved, "AGENTS.md");
	if (!existsSync(agentsMdPath)) {
		writeFileSync(
			agentsMdPath,
			`# Project Context

This file is shared across all agents in the workspace.
Add project-specific instructions, conventions, and guidelines here.

## Workspace Configuration (\`.dpi/config.json\`)

Strict JSON — no comments, no trailing commas.

## Agent Configuration (\`agents/<name>/agent.ts\`)

Each agent exports a standard definition:

- \`export default defineAgent({ ... })\`
- \`parent\` (optional): imported parent definition. The directory name is the agent identity; root omits \`parent\`.
- \`description\` (optional): free-form prose about what this agent is, who it serves,
  and when to delegate to it. Injected into the agent's system prompt as the
  "## Agent identity" section so the LLM has a self-description to refer to
  during multi-agent coordination. Recommended: a few sentences in plain
  English, no formatting.
- \`model\` (optional): \`defineModel({ provider, name })\` for a model declared in this
  agent's \`models\` array, or
  \`defineModel({ id, provider: defineOpenAIProvider(...), contextWindow, thinkingLevel, ... })\`
  for an agent-local model. Custom providers must use \`defineProvider(...)\`.
- \`roles\` (optional): array of role names — see \`team-template/roles/\`.
- \`skills\` (optional): use \`defineSkill({ dir: "./skills" })\` for agent-local skills.
- \`tools\` (required): executable tool definitions, usually explicit built-in helpers such as
  \`createDispatchBashTool()\`, \`createDispatchReadTool()\`, \`createTeamTool()\`, and custom \`defineTool({ name, description, parameters, execute })\`.
  This is the effective tool set for the agent.
- \`contextFiles\` (optional): explicitly include \`./AGENTS.md\` as \`context\` and
  \`./.pi/APPEND_SYSTEM.md\` as \`append_system\` when this agent needs local context.
`,
		);
	}

	const dPiMessageTuiComponentPath = join(tuiComponentsDir, "d-pi-message.ts");
	if (!existsSync(dPiMessageTuiComponentPath)) {
		writeFileSync(
			dPiMessageTuiComponentPath,
			`export { default } from "@sheason/d-pi/.public/d-pi-message";
`,
		);
	}

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
