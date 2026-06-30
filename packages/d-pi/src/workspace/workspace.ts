import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildAgentTsSource } from "../agent-config.ts";
import { ensureAgentConventionDirs } from "../agent-loader.ts";
import type { WorkspaceContext } from "../types.ts";
import {
	discoverWorkspaceContextFiles,
	discoverWorkspaceModelPaths,
	discoverWorkspaceSourcePaths,
	ensureWorkspaceResourceDirs,
} from "./workspace-resources.ts";

const DPI_DIR = ".dpi";
const AGENTS_DIR = "agents";
const SKILLS_DIR = "skills";
const D_PI_PACKAGE_NAME = "@sheason/d-pi";

function dPiPackageRoot(): string {
	return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function packageNameFromDirectory(dir: string): string {
	const basename = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "dpi-workspace";
	const normalized = basename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	return normalized || "dpi-workspace";
}

const packageJsonSchema = z
	.object({
		dependencies: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

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

	const currentRaw = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	const parsed = packageJsonSchema.safeParse(currentRaw);
	const current = parsed.success ? parsed.data : { dependencies: undefined };
	const dependencies = current.dependencies ?? {};
	writeFileSync(
		packageJsonPath,
		`${JSON.stringify(
			{
				...currentRaw,
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

export function isWorkspaceRoot(dir: string): boolean {
	return existsSync(join(resolve(dir), DPI_DIR));
}

export function loadWorkspaceContext(workspaceRoot: string): WorkspaceContext {
	const resolved = resolve(workspaceRoot);

	const appendSystemParts: string[] = [];

	const additionalAgentsFiles: Array<{ path: string; content: string }> = [];
	const additionalSkillPaths: string[] = [];

	pushIfExists(additionalSkillPaths, join(resolved, SKILLS_DIR));

	const workspaceContextFiles = discoverWorkspaceContextFiles(resolved);
	for (const cf of workspaceContextFiles) {
		appendSystemParts.push(`## ${cf.key}\n\n${cf.content}`);
	}

	const appendSystemPrompt = appendSystemParts.length > 0 ? appendSystemParts.join("\n\n") : undefined;

	const workspaceModelPaths = discoverWorkspaceModelPaths(resolved);
	const workspaceSourcePaths = discoverWorkspaceSourcePaths(resolved);

	return {
		workspaceRoot: resolved,
		appendSystemPrompt,
		additionalAgentsFiles,
		additionalSkillPaths,
		workspaceContextFiles,
		workspaceModelPaths,
		workspaceSourcePaths,
	};
}

function pushIfExists(target: string[], path: string): void {
	if (existsSync(path)) {
		target.push(path);
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

	const agentsDir = join(resolved, AGENTS_DIR);
	const rootAgentDir = join(agentsDir, "root");
	mkdirSync(rootAgentDir, { recursive: true });
	ensureAgentConventionDirs(rootAgentDir);

	ensureWorkspaceResourceDirs(resolved);

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

## Workspace Resources (convention-based)

- \`models/**/*.ts\` — model definitions (\`export default defineModel({...})\`), referenced by path (e.g. "openai/gpt-4o")
- \`context/*.md\` — shared context, injected as \`## <filename>\` sections in every agent's system prompt
- \`sources/<name>/source.ts\` — external data sources (subprocesses that push messages to subscribed agents)
- \`skills/*\` — workspace-level skills, available to all agents

## Agent Configuration (\`agents/<name>/agent.ts\`)

Each agent is defined by its directory. Convention-based discovery:

- \`agent.ts\` — minimal definition: \`model\` (path string), \`sources\` (string array), optional \`parent\`/\`description\`
- \`AGENTS.md\` — agent identity (auto-loaded as system context)
- \`skills/\` — agent-local skills (SKILL.md files auto-discovered)
- \`context/*.md\` — extra agent context (auto-appended to system prompt)
- \`tools/*.ts\` — custom tools (\`export default defineTool({...})\`)
- \`commands/*.ts\` — custom slash commands (\`export default defineCommand({...})\`)

Built-in tools (dispatch_bash, dispatch_read, send_message, sync_agents, team, reload, reload_workspace) are always available.
`,
		);
	}

	const rootAgentsMdPath = join(rootAgentDir, "AGENTS.md");
	if (!existsSync(rootAgentsMdPath)) {
		writeFileSync(
			rootAgentsMdPath,
			`# Root Agent

You are the root agent, the user's primary assistant in this workspace.
Workspace-level context from AGENTS.md in the workspace root is also loaded automatically.
`,
		);
	}
}
