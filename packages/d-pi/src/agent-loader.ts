import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentContextFileDefinition,
	AgentDefinition,
	AgentModelDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
} from "./agent-definition.ts";
import { setAgentDefinitionMetadata } from "./agent-definition.ts";

const AGENT_TS_FILE = "agent.ts";

export interface LoadedAgentDefinition extends AgentDefinition {
	name: string;
	agentDir: string;
	agentFilePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertTool(value: unknown, index: number): asserts value is AgentToolDefinition {
	if (!isRecord(value) || typeof value.name !== "string") {
		throw new TypeError(`Agent definition tools[${index}].name must be a string`);
	}
}

function assertSkill(value: unknown): asserts value is AgentSkillDefinition {
	if (!isRecord(value) || typeof value.dir !== "string") {
		throw new TypeError("Agent definition skills.dir must be a string");
	}
}

function assertContextFile(value: unknown, index: number): asserts value is AgentContextFileDefinition {
	if (!isRecord(value)) {
		throw new TypeError(`Agent definition contextFiles[${index}] must be an object`);
	}
	if (value.type !== "context" && value.type !== "append_system") {
		throw new TypeError(`Agent definition contextFiles[${index}].type must be context or append_system`);
	}
	if (typeof value.path !== "string") {
		throw new TypeError(`Agent definition contextFiles[${index}].path must be a string`);
	}
}

function assertModel(value: unknown): asserts value is AgentModelDefinition {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.name !== "string") {
		throw new TypeError("Agent definition model.provider and model.name must be strings");
	}
}

function assertAgentDefinition(value: unknown): asserts value is AgentDefinition {
	if (!isRecord(value)) {
		throw new TypeError("Agent file must default export an object definition");
	}
	if (!Array.isArray(value.tools)) {
		throw new TypeError("Agent definition tools must be an array");
	}
	for (let index = 0; index < value.tools.length; index++) {
		assertTool(value.tools[index], index);
	}
	assertSkill(value.skills);
	if (!Array.isArray(value.contextFiles)) {
		throw new TypeError("Agent definition contextFiles must be an array");
	}
	for (let index = 0; index < value.contextFiles.length; index++) {
		assertContextFile(value.contextFiles[index], index);
	}

	if (value.description !== undefined && typeof value.description !== "string") {
		throw new TypeError("Agent definition description must be a string");
	}
	if (value.roles !== undefined) {
		if (!Array.isArray(value.roles) || value.roles.some((role) => typeof role !== "string")) {
			throw new TypeError("Agent definition roles must be an array of strings");
		}
	}
	if (value.model !== undefined) {
		assertModel(value.model);
	}
	if (value.parent !== undefined) {
		assertAgentDefinition(value.parent);
	}
}

export function normalizeLoadedAgentDefinition(agentFilePath: string, definition: unknown): LoadedAgentDefinition {
	assertAgentDefinition(definition);

	const resolvedAgentFilePath = resolve(agentFilePath);
	const agentDir = dirname(resolvedAgentFilePath);
	const name = basename(agentDir);
	const loaded: LoadedAgentDefinition = {
		...definition,
		name,
		agentDir,
		agentFilePath: resolvedAgentFilePath,
	};

	return setAgentDefinitionMetadata(loaded, {
		name,
		agentDir,
		agentFilePath: resolvedAgentFilePath,
	}) as LoadedAgentDefinition;
}

export async function loadAgentDefinitionFromFile(agentFilePath: string): Promise<LoadedAgentDefinition> {
	const resolvedAgentFilePath = resolve(agentFilePath);
	const agentUrl = pathToFileURL(resolvedAgentFilePath);
	agentUrl.searchParams.set("mtime", String(Math.trunc(statSync(resolvedAgentFilePath).mtimeMs)));
	const agentModule = (await import(/* @vite-ignore */ agentUrl.href)) as { default?: unknown };
	return normalizeLoadedAgentDefinition(resolvedAgentFilePath, agentModule.default);
}

export async function readLoadedAgentDefinitionFromTs(agentDir: string): Promise<LoadedAgentDefinition | undefined> {
	const agentFilePath = join(resolve(agentDir), AGENT_TS_FILE);
	if (!existsSync(agentFilePath)) {
		return undefined;
	}
	return loadAgentDefinitionFromFile(agentFilePath);
}
