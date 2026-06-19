import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	loadAgentRuntimeResources,
	resolveAgentSkillDir,
	uniqueAgentContextFileDefinitions,
} from "../agent-context.ts";
import type { AgentContextFileDefinition, AgentSkillDefinition } from "../agent-definition.ts";
import {
	type LoadedAgentDefinition,
	normalizeLoadedAgentDefinition,
	readLoadedAgentDefinitionFromTsSync,
} from "../agent-loader.ts";
import { formatAgentIdentitySection, readAgentIdentitySync } from "../hub/agent-identity.ts";
import { loadWorkspaceContext } from "../workspace/workspace.ts";
import {
	cwdAgentsPath,
	type DPiContextFile,
	readContextFileIfExists,
	readContextFiles,
	uniqueContextFiles,
	uniqueStrings,
	workspaceAgentsPath,
} from "./resource-loader.ts";

const DEFAULT_AGENT_CONTEXT_FILES: AgentContextFileDefinition[] = [
	{ type: "context", path: "./AGENTS.md" },
	{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
];
const DEFAULT_AGENT_SKILL: AgentSkillDefinition = { dir: "./skills" };

export interface DPiContextManagerOptions {
	workspaceRoot: string;
	agentName: string;
	agentDir?: string;
	cwd?: string;
	roles?: string[];
}

interface DPiContextSnapshot {
	systemPromptParts: string[];
	contextFiles: DPiContextFile[];
	skills: string[];
	extensions: string[];
}

function createDefaultAgentDefinition(agentDir: string): LoadedAgentDefinition {
	return normalizeLoadedAgentDefinition(join(resolve(agentDir), "agent.ts"), {
		tools: [],
		skills: DEFAULT_AGENT_SKILL,
		contextFiles: DEFAULT_AGENT_CONTEXT_FILES,
	});
}

function readConfiguredAgentDefinition(agentDir: string): LoadedAgentDefinition | undefined {
	try {
		return readLoadedAgentDefinitionFromTsSync(agentDir);
	} catch (err) {
		const agentFilePath = join(resolve(agentDir), "agent.ts");
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse agent.ts at ${agentFilePath}: ${message}`);
	}
}

function createRuntimeAgentDefinition(agentDir: string): LoadedAgentDefinition {
	const defaultAgent = createDefaultAgentDefinition(agentDir);
	const configuredAgent = readConfiguredAgentDefinition(agentDir);
	const baseAgent = configuredAgent ?? defaultAgent;
	return {
		...baseAgent,
		contextFiles: uniqueAgentContextFileDefinitions(baseAgent, [
			...baseAgent.contextFiles,
			...DEFAULT_AGENT_CONTEXT_FILES,
		]),
	};
}

function loadAgentSkillPaths(agent: LoadedAgentDefinition): string[] {
	const paths: string[] = [];
	for (const skill of [agent.skills, DEFAULT_AGENT_SKILL]) {
		const skillPath = resolveAgentSkillDir(agent, skill);
		if (existsSync(skillPath)) {
			paths.push(skillPath);
		}
	}
	return paths;
}

export class DPiContextManager {
	private readonly _workspaceRoot: string;
	private readonly _agentName: string;
	private readonly _agentDir: string;
	private readonly _cwd: string;
	private readonly _roles: string[] | undefined;
	private _snapshot: DPiContextSnapshot | undefined;

	constructor(options: DPiContextManagerOptions) {
		this._workspaceRoot = resolve(options.workspaceRoot);
		this._agentName = options.agentName;
		this._agentDir = resolve(options.agentDir ?? join(this._workspaceRoot, "agents", options.agentName));
		this._cwd = resolve(options.cwd ?? this._agentDir);
		this._roles = options.roles ? [...options.roles] : undefined;
	}

	loadSystemPromptParts(): string[] {
		return [...this._getSnapshot().systemPromptParts];
	}

	loadContextFiles(): DPiContextFile[] {
		return this._getSnapshot().contextFiles.map((file) => ({ ...file }));
	}

	loadSkills(): string[] {
		return [...this._getSnapshot().skills];
	}

	loadExtensions(): string[] {
		return [...this._getSnapshot().extensions];
	}

	reload(): void {
		this._snapshot = this._loadSnapshot();
	}

	private _getSnapshot(): DPiContextSnapshot {
		if (!this._snapshot) {
			this._snapshot = this._loadSnapshot();
		}
		return this._snapshot;
	}

	private _loadSnapshot(): DPiContextSnapshot {
		const agentDefinition = createRuntimeAgentDefinition(this._agentDir);
		const agentRuntimeResources = loadAgentRuntimeResources(agentDefinition);
		const identity = readAgentIdentitySync(this._agentDir);
		const workspaceContext = loadWorkspaceContext(this._workspaceRoot, {
			agentName: this._agentName,
			roles: this._roles ?? identity?.roles,
		});
		const systemPromptParts = [
			workspaceContext.appendSystemPrompt,
			identity ? formatAgentIdentitySection(identity) : undefined,
			...agentRuntimeResources.appendSystemPrompt,
		].filter((part): part is string => part !== undefined);

		const workspaceContextFile = readContextFileIfExists(workspaceAgentsPath(this._workspaceRoot));
		const localContextFiles = this._cwd === this._agentDir ? [] : readContextFiles([cwdAgentsPath(this._cwd)]);
		const contextFiles = uniqueContextFiles([
			...(workspaceContextFile ? [workspaceContextFile] : []),
			...(workspaceContext.additionalAgentsFiles ?? []),
			...localContextFiles,
			...agentRuntimeResources.agentsFiles,
		]);

		const skills = uniqueStrings([...workspaceContext.additionalSkillPaths, ...loadAgentSkillPaths(agentDefinition)]);

		return {
			systemPromptParts,
			contextFiles,
			skills,
			extensions: uniqueStrings(workspaceContext.additionalExtensionPaths),
		};
	}
}
