import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentContextFileDefinition,
	AgentDefinition,
	AgentModelDefinition,
	AgentProviderDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
} from "./agent-definition.ts";
import { setAgentDefinitionMetadata } from "./agent-definition.ts";
import { defineSource, type SourceDefinition } from "./workspace-definition.ts";

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
	if (!isRecord(value)) {
		throw new TypeError(`Agent definition tools[${index}] must be an executable tool object`);
	}
	if (typeof value.name !== "string") {
		throw new TypeError(`Agent definition tools[${index}].name must be a string`);
	}
	if (typeof value.label !== "string") {
		throw new TypeError(`Agent definition tools[${index}].label must be a string`);
	}
	if (typeof value.description !== "string") {
		throw new TypeError(`Agent definition tools[${index}].description must be a string`);
	}
	if (!isRecord(value.parameters)) {
		throw new TypeError(`Agent definition tools[${index}].parameters must be an object`);
	}
	if (typeof value.execute !== "function") {
		throw new TypeError(`Agent definition tools[${index}].execute must be a function`);
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
	if (!isRecord(value)) {
		throw new TypeError("Agent definition model must be an object");
	}
	if ("id" in value) {
		assertLocalModel(value, "model");
		return;
	}
	if (typeof value.provider !== "string" || typeof value.name !== "string") {
		throw new TypeError("Agent definition model.provider and model.name must be strings for model references");
	}
}

function assertProvider(value: unknown, context: string): asserts value is AgentProviderDefinition {
	if (!isRecord(value)) {
		throw new TypeError(`Agent definition ${context} must be an object or provider string`);
	}
	if (typeof value.provider !== "string") {
		throw new TypeError(`Agent definition ${context}.provider must be a string`);
	}
	if (typeof value.api !== "string") {
		throw new TypeError(`Agent definition ${context}.api must be a string`);
	}
	if (typeof value.baseUrl !== "string") {
		throw new TypeError(`Agent definition ${context}.baseUrl must be a string`);
	}
	if (value.apiKey !== undefined && typeof value.apiKey !== "string") {
		throw new TypeError(`Agent definition ${context}.apiKey must be a string`);
	}
	if (value.authHeader !== undefined && typeof value.authHeader !== "boolean") {
		throw new TypeError(`Agent definition ${context}.authHeader must be a boolean`);
	}
	if (value.headers !== undefined && !isStringRecord(value.headers)) {
		throw new TypeError(`Agent definition ${context}.headers must be a string record`);
	}
}

function assertLocalModel(value: Record<string, unknown>, context: string): void {
	if (typeof value.id !== "string") {
		throw new TypeError(`Agent definition ${context}.id must be a string`);
	}
	if (value.name !== undefined && typeof value.name !== "string") {
		throw new TypeError(`Agent definition ${context}.name must be a string`);
	}
	if (typeof value.provider === "string") {
		if (value.provider !== "openai" && value.provider !== "anthropic") {
			throw new TypeError(
				`Agent definition ${context}.provider must be openai or anthropic when passed as a string; use defineProvider(...) for custom providers`,
			);
		}
	} else {
		assertProvider(value.provider, `${context}.provider`);
	}
	if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") {
		throw new TypeError(`Agent definition ${context}.reasoning must be a boolean`);
	}
	if (value.input !== undefined) {
		if (!Array.isArray(value.input) || value.input.some((item) => item !== "text" && item !== "image")) {
			throw new TypeError(`Agent definition ${context}.input must contain text or image`);
		}
	}
	if (value.cost !== undefined) {
		assertCost(value.cost, `${context}.cost`);
	}
	if (typeof value.contextWindow !== "number") {
		throw new TypeError(`Agent definition ${context}.contextWindow must be a number`);
	}
	if (value.maxTokens !== undefined && typeof value.maxTokens !== "number") {
		throw new TypeError(`Agent definition ${context}.maxTokens must be a number`);
	}
	if (value.headers !== undefined && !isStringRecord(value.headers)) {
		throw new TypeError(`Agent definition ${context}.headers must be a string record`);
	}
}

function assertCost(value: unknown, context: string): void {
	if (!isRecord(value)) {
		throw new TypeError(`Agent definition ${context} must be an object`);
	}
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
		if (typeof value[key] !== "number") {
			throw new TypeError(`Agent definition ${context}.${key} must be a number`);
		}
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function assertSources(value: unknown): asserts value is Record<string, SourceDefinition> {
	if (!isRecord(value) || Array.isArray(value)) {
		throw new TypeError("Agent definition sources must be an object");
	}
	for (const [key, source] of Object.entries(value)) {
		if (!key.trim()) {
			throw new TypeError("Agent definition sources keys must be non-empty");
		}
		try {
			defineSource(source as SourceDefinition);
		} catch (err) {
			throw new TypeError(
				`Agent definition sources.${key} must be a source definition: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
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
	if (value.skills !== undefined) {
		assertSkill(value.skills);
	}
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
	if (value.models !== undefined) {
		throw new TypeError("Agent definition models is not supported; define shared models in workspace d-pi.ts");
	}
	if (value.sources !== undefined) {
		assertSources(value.sources);
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
