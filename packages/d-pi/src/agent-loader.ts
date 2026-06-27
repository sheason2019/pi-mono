import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentCommandDefinition,
	AgentContextFileDefinition,
	AgentDefinition,
	AgentModelSpec,
	AgentProviderDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
} from "./agent-definition.ts";
import { setAgentDefinitionMetadata } from "./agent-definition.ts";

const AGENT_TS_FILE = "agent.ts";
const AGENTS_MD_FILE = "AGENTS.md";
const SKILLS_DIR = "skills";
const CONTEXT_DIR = "context";
const TOOLS_DIR = "tools";
const COMMANDS_DIR = "commands";

const RESOURCE_EXTENSIONS = [".ts", ".js", ".mjs"];
const MARKDOWN_EXTENSION = ".md";

export interface LoadedAgentDefinition extends AgentDefinition {
	name: string;
	agentDir: string;
	agentFilePath: string;
	contextFiles: AgentContextFileDefinition[];
}

export interface DiscoveredAgentResources {
	skills?: AgentSkillDefinition;
	contextFiles: AgentContextFileDefinition[];
	toolFiles: string[];
	commandFiles: string[];
	hasAgentsMd: boolean;
	hasSkillsDir: boolean;
	hasToolsDir: boolean;
	hasCommandsDir: boolean;
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

function assertModel(value: unknown): asserts value is AgentModelSpec {
	if (typeof value === "string") {
		if (value.trim().length === 0) {
			throw new TypeError("Agent definition model string reference must not be empty");
		}
		return;
	}
	if (!isRecord(value)) {
		throw new TypeError("Agent definition model must be a string path reference or a defineModel({...}) object");
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
	if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") {
		throw new TypeError(`Agent definition ${context}.thinkingLevel must be a string`);
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

function assertAgentDefinition(value: unknown): asserts value is AgentDefinition {
	if (!isRecord(value)) {
		throw new TypeError("Agent file must default export an object definition");
	}
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools)) {
			throw new TypeError("Agent definition tools must be an array");
		}
		for (let index = 0; index < value.tools.length; index++) {
			assertTool(value.tools[index], index);
		}
	}
	if (value.skills !== undefined) {
		assertSkill(value.skills);
	}
	if (value.contextFiles !== undefined) {
		throw new TypeError(
			"Agent definition contextFiles is not supported; place markdown files in the context/ directory instead",
		);
	}

	if (value.description !== undefined && typeof value.description !== "string") {
		throw new TypeError("Agent definition description must be a string");
	}
	if (value.model !== undefined) {
		assertModel(value.model);
	}
	if (value.sources !== undefined) {
		if (!Array.isArray(value.sources) || !value.sources.every((s: unknown) => typeof s === "string")) {
			throw new TypeError("Agent definition sources must be an array of string path references");
		}
	}
	if (value.parent !== undefined) {
		assertAgentDefinition(value.parent);
	}
	if (value.autoCompact !== undefined && typeof value.autoCompact !== "boolean") {
		throw new TypeError("Agent definition autoCompact must be a boolean");
	}
	if (value.disableDefaultTools !== undefined && typeof value.disableDefaultTools !== "boolean") {
		throw new TypeError("Agent definition disableDefaultTools must be a boolean");
	}
	if (value.commands !== undefined) {
		if (!Array.isArray(value.commands)) {
			throw new TypeError("Agent definition commands must be an array");
		}
		for (let index = 0; index < value.commands.length; index++) {
			const command = value.commands[index];
			if (!isRecord(command)) {
				throw new TypeError(`Agent definition commands[${index}] must be an object`);
			}
			if (typeof command.name !== "string" || command.name.trim().length === 0) {
				throw new TypeError(`Agent definition commands[${index}].name must be a non-empty string`);
			}
			if (typeof command.description !== "string" || command.description.length === 0) {
				throw new TypeError(`Agent definition commands[${index}].description must be a non-empty string`);
			}
			if (typeof command.execute !== "function") {
				throw new TypeError(`Agent definition commands[${index}].execute must be a function`);
			}
		}
	}
	if (value.middlewares !== undefined) {
		if (!Array.isArray(value.middlewares)) {
			throw new TypeError("Agent definition middlewares must be an array");
		}
		for (let index = 0; index < value.middlewares.length; index++) {
			const middleware = value.middlewares[index];
			if (!isRecord(middleware)) {
				throw new TypeError(`Agent definition middlewares[${index}] must be an object`);
			}
			if (middleware.onInput !== undefined && typeof middleware.onInput !== "function") {
				throw new TypeError(`Agent definition middlewares[${index}].onInput must be a function`);
			}
		}
	}
}

function scanResourceFiles(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		return [];
	}
	const files: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const ext = extname(entry.name);
		if (!RESOURCE_EXTENSIONS.includes(ext)) continue;
		files.push(join(dir, entry.name));
	}
	files.sort();
	return files;
}

function scanContextMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		return [];
	}
	const files: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (extname(entry.name) !== MARKDOWN_EXTENSION) continue;
		files.push(join(dir, entry.name));
	}
	files.sort();
	return files;
}

export function discoverAgentConventionResources(agentDir: string): DiscoveredAgentResources {
	const resolvedDir = resolve(agentDir);
	const skillsDir = join(resolvedDir, SKILLS_DIR);
	const contextDir = join(resolvedDir, CONTEXT_DIR);
	const toolsDir = join(resolvedDir, TOOLS_DIR);
	const commandsDir = join(resolvedDir, COMMANDS_DIR);
	const agentsMdPath = join(resolvedDir, AGENTS_MD_FILE);

	const hasSkillsDir = existsSync(skillsDir) && statSync(skillsDir).isDirectory();
	const hasToolsDir = existsSync(toolsDir) && statSync(toolsDir).isDirectory();
	const hasCommandsDir = existsSync(commandsDir) && statSync(commandsDir).isDirectory();
	const hasAgentsMd = existsSync(agentsMdPath) && statSync(agentsMdPath).isFile();

	const contextFiles: AgentContextFileDefinition[] = [];
	if (hasAgentsMd) {
		contextFiles.push({ type: "context", path: `./${AGENTS_MD_FILE}` });
	}
	for (const mdFile of scanContextMarkdownFiles(contextDir)) {
		const fileName = basename(mdFile);
		contextFiles.push({ type: "append_system", path: `./${CONTEXT_DIR}/${fileName}` });
	}

	return {
		skills: hasSkillsDir ? { dir: `./${SKILLS_DIR}` } : undefined,
		contextFiles,
		toolFiles: scanResourceFiles(toolsDir),
		commandFiles: scanResourceFiles(commandsDir),
		hasAgentsMd,
		hasSkillsDir,
		hasToolsDir,
		hasCommandsDir,
	};
}

async function loadToolFile(filePath: string): Promise<AgentToolDefinition> {
	const resolved = resolve(filePath);
	const fileUrl = pathToFileURL(resolved);
	fileUrl.searchParams.set("mtime", String(Math.trunc(statSync(resolved).mtimeMs)));
	const mod = (await import(/* @vite-ignore */ fileUrl.href)) as { default?: unknown };
	if (!mod.default || typeof mod.default !== "object") {
		throw new Error(`Tool file ${filePath} must export default defineTool({...})`);
	}
	return mod.default as AgentToolDefinition;
}

async function loadCommandFile(filePath: string): Promise<AgentCommandDefinition> {
	const resolved = resolve(filePath);
	const fileUrl = pathToFileURL(resolved);
	fileUrl.searchParams.set("mtime", String(Math.trunc(statSync(resolved).mtimeMs)));
	const mod = (await import(/* @vite-ignore */ fileUrl.href)) as { default?: unknown };
	if (!mod.default || typeof mod.default !== "object") {
		throw new Error(`Command file ${filePath} must export default defineCommand({...})`);
	}
	return mod.default as AgentCommandDefinition;
}

export async function normalizeLoadedAgentDefinition(
	agentFilePath: string,
	definition: unknown,
): Promise<LoadedAgentDefinition> {
	assertAgentDefinition(definition);

	const resolvedAgentFilePath = resolve(agentFilePath);
	const agentDir = dirname(resolvedAgentFilePath);
	const name = basename(agentDir);

	const discovered = discoverAgentConventionResources(agentDir);

	const tools = [...(definition.tools ?? [])];
	if (discovered.toolFiles.length > 0) {
		const loadedTools = await Promise.all(discovered.toolFiles.map(loadToolFile));
		const existingToolNames = new Set(tools.map((t) => t.name));
		for (const tool of loadedTools) {
			if (!existingToolNames.has(tool.name)) {
				tools.push(tool);
			}
		}
	}

	const commands = [...(definition.commands ?? [])];
	if (discovered.commandFiles.length > 0) {
		const loadedCommands = await Promise.all(discovered.commandFiles.map(loadCommandFile));
		const existingCommandNames = new Set(commands.map((c) => c.name));
		for (const cmd of loadedCommands) {
			if (!existingCommandNames.has(cmd.name)) {
				commands.push(cmd);
			}
		}
	}

	const contextFiles = discovered.contextFiles;

	const skills = definition.skills ?? discovered.skills;

	const loaded: LoadedAgentDefinition = {
		...definition,
		tools,
		commands,
		contextFiles,
		...(skills ? { skills } : {}),
		autoCompact: definition.autoCompact ?? true,
		disableDefaultTools: definition.disableDefaultTools ?? false,
		sources: definition.sources ?? [],
		middlewares: definition.middlewares ?? [],
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

export function ensureAgentConventionDirs(agentDir: string): void {
	const resolved = resolve(agentDir);
	const dirs = [
		join(resolved, SKILLS_DIR),
		join(resolved, CONTEXT_DIR),
		join(resolved, TOOLS_DIR),
		join(resolved, COMMANDS_DIR),
	];
	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
