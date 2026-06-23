import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModelDefinition, AgentProviderDefinition } from "./agent-definition.ts";

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
	reload: "createReloadTool",
};

function formatArrayLiteral(values: string[]): string {
	return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
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
		const fields = [
			`provider: ${JSON.stringify(model.provider)}`,
			`name: ${JSON.stringify(model.name)}`,
			...(model.description === undefined ? [] : [`description: ${JSON.stringify(model.description)}`]),
		];
		return `defineModel({ ${fields.join(", ")} })`;
	}
	const lines = ["defineModel({"];
	lines.push(`${indent}\tid: ${JSON.stringify(model.id)},`);
	if (model.name !== undefined) lines.push(`${indent}\tname: ${JSON.stringify(model.name)},`);
	if (model.description !== undefined) lines.push(`${indent}\tdescription: ${JSON.stringify(model.description)},`);
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
	fieldName: "includeTools" | "excludeTools" | "toolNames",
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

export interface AgentTsSourceConfig {
	name: string;
	parentName?: string;
	description?: string;
	roles?: string[];
	modelDefinition?: AgentModelDefinition;
	toolNames?: string[];
}

export function resolveMigratedToolNames(config: {
	name: string;
	includeTools?: string[];
	excludeTools?: string[];
}): string[] {
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

export function buildAgentTsSource(config: AgentTsSourceConfig): string {
	const toolNames = config.toolNames ?? [...DEFAULT_AGENT_TOOL_NAMES];
	assertKnownToolNames(config.name, "toolNames", toolNames);
	const lines = [
		'import { createCreateAgentTool, createDestroyAgentTool, createDispatchBashTool, createDispatchEditTool, createDispatchFindTool, createDispatchGrepTool, createDispatchLsTool, createDispatchReadTool, createDispatchTools, createDispatchWriteTool, createReloadTool, createSendMessageTool, createTeamTool, defineAgent, defineAnthropicProvider, defineContextFile, defineModel, defineOpenAIProvider, defineProvider, defineSkill } from "@sheason/d-pi";',
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

export function writeAgentTsConfig(agentDir: string, config: AgentTsSourceConfig): void {
	writeFileSync(join(agentDir, AGENT_TS_FILE), buildAgentTsSource(config));
}
