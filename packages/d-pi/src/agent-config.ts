import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentLocalModelDefinition,
	type AgentModelDefinition,
	type AgentProviderDefinition,
	getAgentDefinitionMetadata,
} from "./agent-definition.ts";
import { type LoadedAgentDefinition, readLoadedAgentDefinitionFromTs } from "./agent-loader.ts";
import type { AgentConfig } from "./types.ts";

export const AGENT_TS_FILE = "agent.ts";
export const AGENT_SESSION_DIR = "session";

export const DEFAULT_AGENT_TOOL_NAMES = [
	"dispatch_bash",
	"dispatch_read",
	"dispatch_ls",
	"dispatch_grep",
	"dispatch_find",
	"dispatch_write",
	"dispatch_edit",
	"send_message",
	"create_agent",
	"destroy_agent",
	"team",
	"set_source",
	"get_source",
	"delete_source",
	"reload",
] as const;

const DISPATCH_TOOL_NAMES = [
	"dispatch_bash",
	"dispatch_read",
	"dispatch_ls",
	"dispatch_grep",
	"dispatch_find",
	"dispatch_write",
	"dispatch_edit",
] as const;

const TOOL_HELPER_NAMES: Record<(typeof DEFAULT_AGENT_TOOL_NAMES)[number], string> = {
	dispatch_bash: "createDispatchBashTool",
	dispatch_read: "createDispatchReadTool",
	dispatch_ls: "createDispatchLsTool",
	dispatch_grep: "createDispatchGrepTool",
	dispatch_find: "createDispatchFindTool",
	dispatch_write: "createDispatchWriteTool",
	dispatch_edit: "createDispatchEditTool",
	send_message: "createSendMessageTool",
	create_agent: "createCreateAgentTool",
	destroy_agent: "createDestroyAgentTool",
	team: "createTeamTool",
	set_source: "createSetSourceTool",
	get_source: "createGetSourceTool",
	delete_source: "createDeleteSourceTool",
	reload: "createReloadTool",
};

function formatArrayLiteral(values: string[]): string {
	return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function parseModelSpec(model: string): { provider: string; name: string } {
	const separatorIndex = model.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
		return { provider: "unknown", name: model };
	}
	return {
		provider: model.slice(0, separatorIndex),
		name: model.slice(separatorIndex + 1),
	};
}

function modelDefinitionSpec(model: AgentModelDefinition): string {
	if ("id" in model) {
		const provider = modelProviderName(model);
		return model.id.startsWith(`${provider}/`) ? model.id : `${provider}/${model.id}`;
	}
	return `${model.provider}/${model.name}`;
}

function modelProviderName(model: AgentLocalModelDefinition): string {
	return typeof model.provider === "string" ? model.provider : model.provider.provider;
}

function modelMatchesSpec(model: AgentModelDefinition, spec: string): boolean {
	if (modelDefinitionSpec(model) === spec) {
		return true;
	}
	if ("id" in model) {
		const provider = modelProviderName(model);
		return spec === `${provider}/${model.id}`;
	}
	return false;
}

function formatStringRecord(record: Record<string, string>): string {
	const entries = Object.entries(record);
	if (entries.length === 0) {
		return "{}";
	}
	return `{ ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")} }`;
}

function formatJsonValue(value: unknown): string {
	return JSON.stringify(value);
}

function formatProviderExpression(provider: AgentProviderDefinition): string {
	const helper = providerHelper(provider);
	if (helper) {
		const fields: string[] = [];
		if (provider.provider !== helper.defaultProvider) fields.push(`provider: ${JSON.stringify(provider.provider)}`);
		if (provider.api !== helper.defaultApi) fields.push(`api: ${JSON.stringify(provider.api)}`);
		if (provider.baseUrl !== helper.defaultBaseUrl) fields.push(`baseUrl: ${JSON.stringify(provider.baseUrl)}`);
		if (provider.apiKey !== undefined) fields.push(`apiKey: ${JSON.stringify(provider.apiKey)}`);
		if (provider.authHeader !== undefined) fields.push(`authHeader: ${JSON.stringify(provider.authHeader)}`);
		if (provider.headers !== undefined) fields.push(`headers: ${formatStringRecord(provider.headers)}`);
		if (provider.compat !== undefined) fields.push(`compat: ${formatJsonValue(provider.compat)}`);
		return fields.length === 0 ? `${helper.name}()` : `${helper.name}({ ${fields.join(", ")} })`;
	}
	const fields = [
		`provider: ${JSON.stringify(provider.provider)}`,
		`api: ${JSON.stringify(provider.api)}`,
		`baseUrl: ${JSON.stringify(provider.baseUrl)}`,
	];
	if (provider.apiKey !== undefined) fields.push(`apiKey: ${JSON.stringify(provider.apiKey)}`);
	if (provider.authHeader !== undefined) fields.push(`authHeader: ${JSON.stringify(provider.authHeader)}`);
	if (provider.headers !== undefined) fields.push(`headers: ${formatStringRecord(provider.headers)}`);
	if (provider.compat !== undefined) fields.push(`compat: ${formatJsonValue(provider.compat)}`);
	return `defineProvider({ ${fields.join(", ")} })`;
}

function providerHelper(provider: AgentProviderDefinition):
	| {
			name: "defineOpenAIProvider" | "defineAnthropicProvider";
			defaultProvider: string;
			defaultApi: string;
			defaultBaseUrl: string;
	  }
	| undefined {
	if (provider.provider === "openai") {
		return {
			name: "defineOpenAIProvider",
			defaultProvider: "openai",
			defaultApi: "openai-responses",
			defaultBaseUrl: "https://api.openai.com/v1",
		};
	}
	if (provider.provider === "anthropic") {
		return {
			name: "defineAnthropicProvider",
			defaultProvider: "anthropic",
			defaultApi: "anthropic-messages",
			defaultBaseUrl: "https://api.anthropic.com",
		};
	}
	return undefined;
}

function formatModelExpression(model: AgentModelDefinition, indent: string): string {
	if (!("id" in model)) {
		return `defineModel({ provider: ${JSON.stringify(model.provider)}, name: ${JSON.stringify(model.name)} })`;
	}
	const lines = ["defineModel({"];
	lines.push(`${indent}\tid: ${JSON.stringify(model.id)},`);
	if (model.name !== undefined) lines.push(`${indent}\tname: ${JSON.stringify(model.name)},`);
	lines.push(
		`${indent}\tprovider: ${
			typeof model.provider === "string" ? JSON.stringify(model.provider) : formatProviderExpression(model.provider)
		},`,
	);
	if (model.reasoning !== undefined) lines.push(`${indent}\treasoning: ${JSON.stringify(model.reasoning)},`);
	if (model.thinkingLevelMap !== undefined) {
		lines.push(`${indent}\tthinkingLevelMap: ${formatJsonValue(model.thinkingLevelMap)},`);
	}
	if (model.input !== undefined) lines.push(`${indent}\tinput: ${formatArrayLiteral(model.input)},`);
	if (model.cost !== undefined) {
		lines.push(`${indent}\tcost: ${formatJsonValue(model.cost)},`);
	}
	lines.push(`${indent}\tcontextWindow: ${model.contextWindow},`);
	if (model.maxTokens !== undefined) lines.push(`${indent}\tmaxTokens: ${model.maxTokens},`);
	if (model.headers !== undefined) lines.push(`${indent}\theaders: ${formatStringRecord(model.headers)},`);
	if (model.compat !== undefined) lines.push(`${indent}\tcompat: ${formatJsonValue(model.compat)},`);
	lines.push(`${indent}})`);
	return lines.join("\n");
}

function formatToolExpressions(toolNames: string[]): string[] {
	const remainingToolNames = new Set(toolNames);
	const expressions: string[] = [];
	if (DISPATCH_TOOL_NAMES.every((toolName) => remainingToolNames.has(toolName))) {
		expressions.push("...createDispatchTools()");
		for (const toolName of DISPATCH_TOOL_NAMES) {
			remainingToolNames.delete(toolName);
		}
	}
	for (const toolName of toolNames) {
		if (!remainingToolNames.has(toolName)) {
			continue;
		}
		const helperName = TOOL_HELPER_NAMES[toolName as (typeof DEFAULT_AGENT_TOOL_NAMES)[number]];
		if (!helperName) {
			throw new Error(`Cannot emit agent.ts: unknown tool helper for ${toolName}`);
		}
		expressions.push(`${helperName}()`);
		remainingToolNames.delete(toolName);
	}
	return expressions;
}

export function assertKnownToolNames(
	agentName: string,
	fieldName: "includeTools" | "excludeTools",
	toolNames: string[],
): void {
	const knownNames = new Set<string>(DEFAULT_AGENT_TOOL_NAMES);
	for (const toolName of toolNames) {
		if (!knownNames.has(toolName)) {
			throw new Error(
				`Cannot migrate agent "${agentName}": unknown tool name "${toolName}" in ${fieldName}. ` +
					`Known tools: ${DEFAULT_AGENT_TOOL_NAMES.join(", ")}`,
			);
		}
	}
}

export function resolveActiveToolNames(config: Pick<AgentConfig, "name" | "includeTools" | "excludeTools">): string[] {
	if (config.includeTools && config.excludeTools) {
		throw new Error(`Cannot migrate agent "${config.name}": includeTools and excludeTools are mutually exclusive.`);
	}
	if (config.includeTools) {
		assertKnownToolNames(config.name, "includeTools", config.includeTools);
		return [...config.includeTools];
	}
	if (config.excludeTools) {
		assertKnownToolNames(config.name, "excludeTools", config.excludeTools);
		const excludeSet = new Set(config.excludeTools);
		return DEFAULT_AGENT_TOOL_NAMES.filter((toolName) => !excludeSet.has(toolName));
	}
	return [...DEFAULT_AGENT_TOOL_NAMES];
}

export function buildAgentTsSource(
	config: Pick<
		AgentConfig,
		"name" | "parentName" | "description" | "roles" | "model" | "includeTools" | "excludeTools"
	> & { modelDefinition?: AgentModelDefinition; models?: AgentModelDefinition[] },
): string {
	const toolNames = resolveActiveToolNames({
		name: config.name,
		includeTools: config.includeTools,
		excludeTools: config.excludeTools,
	});
	const lines = [
		'import { createCreateAgentTool, createDeleteSourceTool, createDestroyAgentTool, createDispatchBashTool, createDispatchEditTool, createDispatchFindTool, createDispatchGrepTool, createDispatchLsTool, createDispatchReadTool, createDispatchTools, createDispatchWriteTool, createGetSourceTool, createReloadTool, createSendMessageTool, createSetSourceTool, createTeamTool, defineAgent, defineAnthropicProvider, defineContextFile, defineModel, defineOpenAIProvider, defineProvider, defineSkill } from "@sheason/d-pi";',
	];
	if (config.parentName) {
		lines.push(`import parentAgent from "../${config.parentName}/agent.ts";`);
	}
	lines.push("");
	lines.push("export default defineAgent({");
	if (config.parentName) {
		lines.push("\tparent: parentAgent,");
	}
	if (config.description !== undefined) {
		lines.push(`\tdescription: ${JSON.stringify(config.description)},`);
	}
	if (config.roles && config.roles.length > 0) {
		lines.push(`\troles: ${formatArrayLiteral(config.roles)},`);
	}
	if (config.modelDefinition) {
		lines.push(`\tmodel: ${formatModelExpression(config.modelDefinition, "\t")},`);
	} else if (config.model) {
		const model = parseModelSpec(config.model);
		lines.push(
			`\tmodel: defineModel({ provider: ${JSON.stringify(model.provider)}, name: ${JSON.stringify(model.name)} }),`,
		);
	}
	if (config.models && config.models.length > 0) {
		lines.push("\tmodels: [");
		for (const model of config.models) {
			lines.push(`${formatModelExpression(model, "\t\t")},`.replace(/^/gm, "\t\t"));
		}
		lines.push("\t],");
	}
	lines.push('\tskills: defineSkill({ dir: "./skills" }),');
	lines.push("\ttools: [");
	for (const expression of formatToolExpressions(toolNames)) {
		lines.push(`\t\t${expression},`);
	}
	lines.push("\t],");
	lines.push("\tcontextFiles: [");
	lines.push('\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),');
	lines.push('\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),');
	lines.push("\t],");
	lines.push("});");
	lines.push("");
	return lines.join("\n");
}

export function writeAgentTsConfig(
	agentDir: string,
	config: Pick<
		AgentConfig,
		"name" | "parentName" | "description" | "roles" | "model" | "includeTools" | "excludeTools"
	> & { modelDefinition?: AgentModelDefinition; models?: AgentModelDefinition[] },
): void {
	writeFileSync(join(agentDir, AGENT_TS_FILE), buildAgentTsSource(config));
}

function agentDefinitionToPersistedConfig(agent: LoadedAgentDefinition): AgentConfig {
	return {
		name: agent.name,
		parentName: agent.parent ? getAgentDefinitionMetadata(agent.parent)?.name : undefined,
		description: agent.description,
		roles: agent.roles,
		model: agent.model ? modelDefinitionSpec(agent.model) : undefined,
		includeTools: agent.tools.map((tool) => tool.name),
	};
}

export async function persistModelInAgentTs(agentDir: string, model: string): Promise<void> {
	const currentDefinition = await readLoadedAgentDefinitionFromTs(agentDir);
	if (!currentDefinition) {
		throw new Error(`agent.ts not present at ${join(agentDir, AGENT_TS_FILE)}`);
	}
	const currentConfig = agentDefinitionToPersistedConfig(currentDefinition);
	const existingModels = [currentDefinition.model, ...(currentDefinition.models ?? [])].filter(
		(candidate): candidate is AgentModelDefinition => candidate !== undefined,
	);
	const modelDefinition = existingModels.find((candidate) => modelMatchesSpec(candidate, model));
	writeAgentTsConfig(agentDir, {
		name: currentConfig.name,
		parentName: currentConfig.parentName,
		description: currentConfig.description,
		roles: currentConfig.roles,
		model: modelDefinition ? undefined : model,
		modelDefinition,
		models: currentDefinition.models,
		includeTools: currentConfig.includeTools,
	});
}
