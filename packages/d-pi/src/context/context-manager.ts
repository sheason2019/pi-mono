import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAgentRuntimeResources, resolveAgentSkillDir } from "../agent-context.ts";
import { type LoadedAgentDefinition, normalizeLoadedAgentDefinition } from "../agent-loader.ts";
import { agentDefinitionToConfig, formatAgentIdentitySection } from "../hub/agent-identity.ts";
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

export interface DPiContextManagerOptions {
	workspaceRoot: string;
	agentName: string;
	agentDir?: string;
	cwd?: string;
	roles?: string[];
	agentDefinition?: LoadedAgentDefinition;
}

interface DPiContextSnapshot {
	systemPromptParts: string[];
	contextFiles: DPiContextFile[];
	skills: string[];
}

function createDefaultAgentDefinition(agentDir: string): LoadedAgentDefinition {
	return normalizeLoadedAgentDefinition(join(resolve(agentDir), "agent.ts"), {
		tools: [],
		contextFiles: [],
	});
}

function createRuntimeAgentDefinition(agentDir: string): LoadedAgentDefinition {
	return createDefaultAgentDefinition(agentDir);
}

function loadAgentSkillPaths(agent: LoadedAgentDefinition): string[] {
	const paths: string[] = [];
	const skills = agent.skills ? [agent.skills] : [];
	for (const skill of skills) {
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
	private _roles: string[] | undefined;
	private _agentDefinition: LoadedAgentDefinition | undefined;
	private _snapshot: DPiContextSnapshot | undefined;

	constructor(options: DPiContextManagerOptions) {
		this._workspaceRoot = resolve(options.workspaceRoot);
		this._agentName = options.agentName;
		this._agentDir = resolve(options.agentDir ?? join(this._workspaceRoot, "agents", options.agentName));
		this._cwd = resolve(options.cwd ?? this._agentDir);
		this._roles = options.roles ? [...options.roles] : undefined;
		this._agentDefinition = options.agentDefinition;
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

	getAgentDir(): string {
		return this._agentDir;
	}

	updateAgentDefinition(agentDefinition: LoadedAgentDefinition | undefined): void {
		this._agentDefinition = agentDefinition;
		this._roles = undefined;
		this._snapshot = undefined;
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
		const agentDefinition = this._agentDefinition ?? createRuntimeAgentDefinition(this._agentDir);
		const agentRuntimeResources = loadAgentRuntimeResources(agentDefinition);
		const identity = this._agentDefinition ? agentDefinitionToConfig(this._agentDefinition) : undefined;
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
		};
	}
}
