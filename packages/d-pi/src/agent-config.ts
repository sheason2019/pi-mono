import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
	"set_model",
	"set_thinking_level",
] as const;

function parseStringLiteral(literal: string, context: string): string {
	try {
		return JSON.parse(literal) as string;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid string literal in ${context}: ${message}`);
	}
}

function parseStringArrayLiteral(literal: string, context: string): string[] {
	try {
		const parsed = JSON.parse(literal) as unknown;
		if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
			throw new TypeError("expected an array of strings");
		}
		return parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid array literal in ${context}: ${message}`);
	}
}

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
	>,
): string {
	const toolNames = resolveActiveToolNames({
		name: config.name,
		includeTools: config.includeTools,
		excludeTools: config.excludeTools,
	});
	const lines = [
		'import { dPiMessageTuiComponent, defineAgent, defineContextFile, defineModel, defineSkill, defineTool, defineTuiComponent } from "@sheason/d-pi";',
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
	if (config.model) {
		const model = parseModelSpec(config.model);
		lines.push(
			`\tmodel: defineModel({ provider: ${JSON.stringify(model.provider)}, name: ${JSON.stringify(model.name)} }),`,
		);
	}
	lines.push('\tskills: defineSkill({ dir: "./skills" }),');
	lines.push("\ttools: [");
	for (const toolName of toolNames) {
		lines.push(`\t\tdefineTool({ name: ${JSON.stringify(toolName)} }),`);
	}
	lines.push("\t],");
	lines.push("\ttuiComponents: [");
	lines.push("\t\tdefineTuiComponent(dPiMessageTuiComponent),");
	lines.push("\t],");
	lines.push("\tcontextFiles: [");
	lines.push('\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),');
	lines.push('\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),');
	lines.push("\t],");
	lines.push("});");
	lines.push("");
	return lines.join("\n");
}

export function parseAgentTsSource(agentDir: string, source: string): AgentConfig {
	const name = basename(agentDir);
	if (!source.includes("defineAgent(")) {
		throw new Error(`Invalid agent.ts in ${agentDir}: missing defineAgent(...)`);
	}
	if (!source.includes('defineSkill({ dir: "./skills" })')) {
		throw new Error(`Invalid agent.ts in ${agentDir}: missing defineSkill({ dir: "./skills" })`);
	}
	if (!source.includes('defineContextFile({ type: "context", path: "./AGENTS.md" })')) {
		throw new Error(`Invalid agent.ts in ${agentDir}: missing AGENTS.md context file`);
	}
	if (!source.includes('defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" })')) {
		throw new Error(`Invalid agent.ts in ${agentDir}: missing APPEND_SYSTEM context file`);
	}
	const parentMatch = source.match(/import\s+parentAgent\s+from\s+["']\.\.\/([^/]+)\/agent\.ts["'];/);
	const descriptionMatch = source.match(/description:\s*("(?:\\.|[^"])*"),/s);
	const rolesMatch = source.match(/roles:\s*(\[[\s\S]*?\]),/s);
	const modelMatch = source.match(
		/model:\s*defineModel\(\{\s*provider:\s*("(?:\\.|[^"])*"),\s*name:\s*("(?:\\.|[^"])*")\s*\}\),/s,
	);
	const toolMatches = Array.from(source.matchAll(/defineTool\(\{\s*name:\s*("(?:\\.|[^"])*")\s*\}\)/g));

	return {
		name,
		parentName: parentMatch?.[1],
		description: descriptionMatch ? parseStringLiteral(descriptionMatch[1], `${agentDir}/description`) : undefined,
		roles: rolesMatch ? parseStringArrayLiteral(rolesMatch[1], `${agentDir}/roles`) : undefined,
		model: modelMatch
			? `${parseStringLiteral(modelMatch[1], `${agentDir}/model provider`)}/${parseStringLiteral(modelMatch[2], `${agentDir}/model name`)}`
			: undefined,
		includeTools:
			toolMatches.length > 0
				? toolMatches.map((match) => parseStringLiteral(match[1], `${agentDir}/tools`))
				: undefined,
	};
}

export function readAgentConfigFromTs(agentDir: string): AgentConfig | undefined {
	const configPath = join(agentDir, AGENT_TS_FILE);
	if (!existsSync(configPath)) {
		return undefined;
	}
	const raw = readFileSync(configPath, "utf-8");
	return parseAgentTsSource(agentDir, raw);
}

export function writeAgentTsConfig(
	agentDir: string,
	config: Pick<
		AgentConfig,
		"name" | "parentName" | "description" | "roles" | "model" | "includeTools" | "excludeTools"
	>,
): void {
	writeFileSync(join(agentDir, AGENT_TS_FILE), buildAgentTsSource(config));
}

export function persistModelInAgentTs(agentDir: string, model: string): void {
	const currentConfig = readAgentConfigFromTs(agentDir);
	if (!currentConfig) {
		throw new Error(`agent.ts not present at ${join(agentDir, AGENT_TS_FILE)}`);
	}
	writeAgentTsConfig(agentDir, {
		name: currentConfig.name,
		parentName: currentConfig.parentName,
		description: currentConfig.description,
		roles: currentConfig.roles,
		model,
		includeTools: currentConfig.includeTools,
	});
}
