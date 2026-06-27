import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
	AgentCommandDefinition,
	AgentContextFileDefinition,
	AgentDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
} from "./agent-definition.ts";
import { setAgentDefinitionMetadata } from "./agent-definition.ts";
import { isRecord } from "./shared/schemas.ts";

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

const modelInputLiteralSchema = z.enum(["text", "image"]);
const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const costSchema = z.object({
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
});

const providerSchema = z.object({
	provider: z.string(),
	api: z.string(),
	baseUrl: z.string(),
	apiKey: z.string().optional(),
	authHeader: z.boolean().optional(),
	headers: z.record(z.string()).optional(),
});

const localModelSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	provider: z.union([z.enum(["openai", "anthropic"]), providerSchema]),
	reasoning: z.boolean().optional(),
	thinkingLevel: thinkingLevelSchema.optional(),
	input: z.array(modelInputLiteralSchema).optional(),
	cost: costSchema.optional(),
	contextWindow: z.number(),
	maxTokens: z.number().optional(),
	headers: z.record(z.string()).optional(),
});

const modelReferenceSchema = z.object({
	provider: z.string(),
	name: z.string(),
	description: z.string().optional(),
});

const modelSchema = z.union([z.string().min(1), localModelSchema, modelReferenceSchema]);

const skillSchema = z.object({
	dir: z.string(),
});

const toolSchema = z.object({
	name: z.string(),
	label: z.string(),
	description: z.string(),
	parameters: z.record(z.unknown()),
	prepareArguments: z.function().optional(),
	executionMode: z.enum(["sequential", "parallel"]).optional(),
	execute: z.function(),
});

const commandSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	aliases: z.array(z.string()).optional(),
	execute: z.function(),
});

const middlewareSchema = z.object({
	onInput: z.function().optional(),
});

const agentDefinitionRawSchema = z.lazy(() =>
	z.object({
		parent: z.unknown().optional(),
		description: z.string().optional(),
		model: modelSchema.optional(),
		tools: z.array(toolSchema).default([]),
		skills: skillSchema.optional(),
		sources: z.array(z.string()).default([]),
		commands: z.array(commandSchema).default([]),
		middlewares: z.array(middlewareSchema).default([]),
		autoCompact: z.boolean().default(true),
		disableDefaultTools: z.boolean().default(false),
	}),
);

const BANNED_CONTEXT_FILES_FIELD = "contextFiles";

function assertAgentDefinition(value: unknown): asserts value is AgentDefinition {
	if (isRecord(value) && BANNED_CONTEXT_FILES_FIELD in value) {
		throw new TypeError(
			"Agent definition contextFiles is not supported; place markdown files in the context/ directory instead",
		);
	}
	agentDefinitionRawSchema.parse(value);
	const parent = (value as { parent?: unknown }).parent;
	if (parent !== undefined && parent !== null) {
		assertAgentDefinition(parent);
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
	toolSchema.parse(mod.default);
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
	commandSchema.parse(mod.default);
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
