import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModelDefinition } from "./agent-definition.ts";

export const AGENT_TS_FILE = "agent.ts";
export const AGENT_SESSION_DIR = "session";

export const DEFAULT_BUILTIN_TOOL_NAMES = [
	"dispatch_bash",
	"dispatch_read",
	"send_message",
	"sync_agents",
	"team",
	"reload",
	"reload_workspace",
] as const;

export interface AgentTsSourceConfig {
	name: string;
	parentName?: string;
	description?: string;
	modelDefinition?: AgentModelDefinition;
	modelRef?: string;
	sources?: string[];
}

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

function formatProviderExpression(provider: {
	provider: string;
	api: string;
	baseUrl: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	compat?: unknown;
}): string {
	if (provider.provider === "openai") {
		const fields: string[] = [];
		if (provider.api !== "openai-responses") fields.push(`api: ${JSON.stringify(provider.api)}`);
		if (provider.baseUrl !== "https://api.openai.com/v1") fields.push(`baseUrl: ${JSON.stringify(provider.baseUrl)}`);
		if (provider.apiKey !== undefined) fields.push(`apiKey: ${JSON.stringify(provider.apiKey)}`);
		if (provider.authHeader !== undefined) fields.push(`authHeader: ${JSON.stringify(provider.authHeader)}`);
		if (provider.headers !== undefined) fields.push(`headers: ${formatStringRecord(provider.headers)}`);
		if (provider.compat !== undefined) fields.push(`compat: ${formatJsonValue(provider.compat)}`);
		return fields.length === 0 ? "defineOpenAIProvider()" : `defineOpenAIProvider({ ${fields.join(", ")} })`;
	}
	if (provider.provider === "anthropic") {
		const fields: string[] = [];
		if (provider.api !== "anthropic-messages") fields.push(`api: ${JSON.stringify(provider.api)}`);
		if (provider.baseUrl !== "https://api.anthropic.com") fields.push(`baseUrl: ${JSON.stringify(provider.baseUrl)}`);
		if (provider.apiKey !== undefined) fields.push(`apiKey: ${JSON.stringify(provider.apiKey)}`);
		if (provider.authHeader !== undefined) fields.push(`authHeader: ${JSON.stringify(provider.authHeader)}`);
		if (provider.headers !== undefined) fields.push(`headers: ${formatStringRecord(provider.headers)}`);
		if (provider.compat !== undefined) fields.push(`compat: ${formatJsonValue(provider.compat)}`);
		return fields.length === 0 ? "defineAnthropicProvider()" : `defineAnthropicProvider({ ${fields.join(", ")} })`;
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
	if (model.thinkingLevel !== undefined) {
		lines.push(`${indent}\tthinkingLevel: ${JSON.stringify(model.thinkingLevel)},`);
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

export function buildAgentTsSource(config: AgentTsSourceConfig): string {
	const lines: string[] = [];

	const imports = new Set<string>(["defineAgent"]);
	if (config.parentName) {
		lines.push(`import parentAgent from "../${config.parentName}/agent.ts";`);
		lines.push("");
	}

	if (config.modelDefinition) {
		if ("id" in config.modelDefinition && typeof config.modelDefinition.provider !== "string") {
			const p = config.modelDefinition.provider;
			if (p.provider === "openai") imports.add("defineOpenAIProvider");
			else if (p.provider === "anthropic") imports.add("defineAnthropicProvider");
			else imports.add("defineProvider");
			imports.add("defineModel");
		} else if (!("id" in config.modelDefinition)) {
			imports.add("defineModel");
		}
	}

	const importExpr = [...imports].sort().join(", ");
	if (lines.length > 0 && lines[0].startsWith("import ")) {
		lines.unshift(`import { ${importExpr} } from "@sheason/d-pi";`);
	} else {
		lines.unshift(`import { ${importExpr} } from "@sheason/d-pi";`);
		if (lines.length > 1) lines.splice(1, 0, "");
	}

	lines.push("// Convention-based agent configuration:");
	lines.push("// - AGENTS.md          → agent identity (auto-loaded as system context)");
	lines.push("// - skills/            → agent skills (auto-discovered SKILL.md files)");
	lines.push("// - context/*.md       → extra context (auto-appended to system prompt)");
	lines.push("// - tools/*.ts         → custom tools (export default defineTool({...}))");
	lines.push("// - commands/*.ts      → custom commands (export default defineCommand({...}))");
	lines.push("//");
	lines.push("// Workspace resources (referenced by path string):");
	lines.push('// - model: "openai/gpt-4o"  → references models/openai/gpt-4o.ts');
	lines.push('// - sources: ["lark-bridge"] → subscribes to sources/lark-bridge');
	lines.push("//");
	lines.push("// Built-in tools (dispatch_bash, dispatch_read, send_message, sync_agents,");
	lines.push("// team, reload, reload_workspace) are always available.");
	lines.push("");

	lines.push("export default defineAgent({");
	if (config.parentName) {
		lines.push("\tparent: parentAgent,");
	}
	if (config.description !== undefined) {
		lines.push(`\tdescription: ${JSON.stringify(config.description)},`);
	}
	if (config.modelRef) {
		lines.push(`\tmodel: ${JSON.stringify(config.modelRef)},`);
	} else if (config.modelDefinition) {
		lines.push(`\tmodel: ${formatModelExpression(config.modelDefinition, "\t")},`);
	}
	if (config.sources && config.sources.length > 0) {
		lines.push(`\tsources: ${formatArrayLiteral(config.sources)},`);
	}
	lines.push("});");
	lines.push("");
	return lines.join("\n");
}

export function writeAgentTsConfig(agentDir: string, config: AgentTsSourceConfig): void {
	writeFileSync(join(agentDir, AGENT_TS_FILE), buildAgentTsSource(config));
}
