import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model, Provider, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ToolDefinition } from "./extension/contracts.ts";
import type { SourceDefinition } from "./workspace-definition.ts";

export interface AgentToolExecutionContext {
	cwd: string;
	hasUI?: boolean;
}

export interface AgentToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>
	extends Omit<ToolDefinition<TParams, TDetails, TState>, "label"> {
	label: string;
}

export interface AgentToolDefinitionInput<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown> {
	name: string;
	label?: string;
	description: string;
	parameters: TParams;
	prepareArguments?: (args: unknown) => Static<TParams>;
	executionMode?: "sequential" | "parallel";
	execute: ToolDefinition<TParams, TDetails, TState>["execute"];
}

export interface AgentSkillDefinition {
	dir: string;
}

export interface AgentContextFileDefinition {
	type: "context" | "append_system";
	path: string;
}

export interface AgentProviderDefinition {
	provider: string;
	api: Api;
	baseUrl: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

export interface AgentModelReferenceDefinition {
	provider: string;
	name: string;
}

export interface AgentLocalModelDefinition {
	id: string;
	name?: string;
	provider: AgentProviderDefinition | Provider;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: Array<"text" | "image">;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

export type AgentModelDefinition = AgentModelReferenceDefinition | AgentLocalModelDefinition;

export type AgentRoleDefinition = string;

export interface AgentDefinitionInput {
	/** Imported parent agent definition. This builds topology only; it does not imply inheritance. */
	parent?: AgentDefinition;
	description?: string;
	roles?: AgentRoleDefinition[];
	model?: AgentModelDefinition;
	models?: AgentModelDefinition[];
	sources?: Record<string, SourceDefinition>;
	tools?: AgentToolDefinition[];
	skills?: AgentSkillDefinition;
	contextFiles?: AgentContextFileDefinition[];
}

export interface AgentDefinition {
	/** Imported parent agent definition. This builds topology only; it does not imply inheritance. */
	parent?: AgentDefinition;
	description?: string;
	roles?: AgentRoleDefinition[];
	model?: AgentModelDefinition;
	models?: AgentModelDefinition[];
	sources?: Record<string, SourceDefinition>;
	tools: AgentToolDefinition[];
	skills?: AgentSkillDefinition;
	contextFiles: AgentContextFileDefinition[];
}

const AGENT_DEFINITION_METADATA = Symbol.for("@sheason/d-pi/agent-definition-metadata");

export interface AgentDefinitionMetadata {
	name?: string;
	agentDir?: string;
	agentFilePath?: string;
}

export type AgentDefinitionWithMetadata = AgentDefinition & {
	[AGENT_DEFINITION_METADATA]?: AgentDefinitionMetadata;
};

function inferCallingFilePath(): string | undefined {
	const stack = new Error().stack;
	if (!stack) {
		return undefined;
	}
	const lines = stack.split("\n").slice(1);
	for (const line of lines) {
		const fileUrlMatch = line.match(/(file:\/\/[^):]+):\d+:\d+/);
		const filePath = fileUrlMatch
			? fileURLToPath(fileUrlMatch[1])
			: line.match(/((?:\/|[A-Za-z]:\\).*?agent\.(?:ts|js|mjs)):\d+:\d+/)?.[1];
		if (!filePath) continue;
		const fileName = basename(filePath);
		if (fileName === "agent.ts" || fileName === "agent.js" || fileName === "agent.mjs") {
			return filePath;
		}
	}
	return undefined;
}

export function getAgentDefinitionMetadata(definition: AgentDefinition): AgentDefinitionMetadata | undefined {
	return (definition as AgentDefinitionWithMetadata)[AGENT_DEFINITION_METADATA];
}

export function setAgentDefinitionMetadata(
	definition: AgentDefinition,
	metadata: AgentDefinitionMetadata,
): AgentDefinition {
	Object.defineProperty(definition, AGENT_DEFINITION_METADATA, {
		value: metadata,
		enumerable: false,
		configurable: true,
		writable: false,
	});
	return definition;
}

export function defineTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	input: AgentToolDefinitionInput<TParams, TDetails, TState>,
): AgentToolDefinition<TParams, TDetails, TState> {
	if (typeof input.description !== "string" || input.description.length === 0) {
		throw new TypeError("defineTool requires a non-empty description");
	}
	if (typeof input.execute !== "function") {
		throw new TypeError("defineTool requires an execute function");
	}
	const tool = {
		name: input.name,
		label: input.label ?? input.name,
		description: input.description,
		parameters: input.parameters,
		...(input.prepareArguments === undefined ? {} : { prepareArguments: input.prepareArguments }),
		...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
		execute: input.execute,
	};
	copyHiddenToolProperties(input, tool);
	return tool;
}

export function defineTools(...input: AgentToolDefinition[]): AgentToolDefinition[] {
	return input.map((tool) => defineTool(tool));
}

function copyHiddenToolProperties(source: object, target: object): void {
	for (const symbol of Object.getOwnPropertySymbols(source)) {
		const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
		if (descriptor) {
			Object.defineProperty(target, symbol, descriptor);
		}
	}
}

export function defineSkill(input: AgentSkillDefinition): AgentSkillDefinition {
	return { dir: input.dir };
}

export function defineContextFile(input: AgentContextFileDefinition): AgentContextFileDefinition {
	return { type: input.type, path: input.path };
}

export function defineContextFiles(...input: AgentContextFileDefinition[]): AgentContextFileDefinition[] {
	return input.map(defineContextFile);
}

export function defineProvider(input: AgentProviderDefinition): AgentProviderDefinition {
	return {
		provider: input.provider,
		api: input.api,
		baseUrl: input.baseUrl,
		...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
		...(input.authHeader === undefined ? {} : { authHeader: input.authHeader }),
		...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
		...(input.compat === undefined ? {} : { compat: input.compat }),
	};
}

export function defineOpenAIProvider(
	input: Partial<Omit<AgentProviderDefinition, "api" | "baseUrl" | "provider">> &
		Pick<Partial<AgentProviderDefinition>, "api" | "baseUrl" | "provider"> = {},
): AgentProviderDefinition {
	return defineProvider({
		provider: input.provider ?? "openai",
		api: input.api ?? "openai-responses",
		baseUrl: input.baseUrl ?? "https://api.openai.com/v1",
		...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
		...(input.authHeader === undefined ? {} : { authHeader: input.authHeader }),
		...(input.headers === undefined ? {} : { headers: input.headers }),
		...(input.compat === undefined ? {} : { compat: input.compat }),
	});
}

export function defineAnthropicProvider(
	input: Partial<Omit<AgentProviderDefinition, "api" | "baseUrl" | "provider">> &
		Pick<Partial<AgentProviderDefinition>, "api" | "baseUrl" | "provider"> = {},
): AgentProviderDefinition {
	return defineProvider({
		provider: input.provider ?? "anthropic",
		api: input.api ?? "anthropic-messages",
		baseUrl: input.baseUrl ?? "https://api.anthropic.com",
		...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
		...(input.authHeader === undefined ? {} : { authHeader: input.authHeader }),
		...(input.headers === undefined ? {} : { headers: input.headers }),
		...(input.compat === undefined ? {} : { compat: input.compat }),
	});
}

export function defineModel(input: AgentModelDefinition): AgentModelDefinition {
	if ("id" in input) {
		return {
			id: input.id,
			...(input.name === undefined ? {} : { name: input.name }),
			provider: typeof input.provider === "string" ? input.provider : defineProvider(input.provider),
			...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
			...(input.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...input.thinkingLevelMap } }),
			...(input.input === undefined ? {} : { input: [...input.input] }),
			...(input.cost === undefined
				? {}
				: {
						cost: {
							input: input.cost.input,
							output: input.cost.output,
							cacheRead: input.cost.cacheRead,
							cacheWrite: input.cost.cacheWrite,
						},
					}),
			contextWindow: input.contextWindow,
			...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
			...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
			...(input.compat === undefined ? {} : { compat: input.compat }),
		};
	}
	return { provider: input.provider, name: input.name };
}

export function defineModels(...input: AgentModelDefinition[]): AgentModelDefinition[] {
	return input.map(defineModel);
}

export function defineRole(input: AgentRoleDefinition): AgentRoleDefinition {
	return input;
}

export function defineRoles(...input: AgentRoleDefinition[]): AgentRoleDefinition[] {
	return input.map(defineRole);
}

export function defineAgent(input: AgentDefinitionInput): AgentDefinition {
	const definition: AgentDefinition = {
		...(input.parent === undefined ? {} : { parent: input.parent }),
		...(input.description === undefined ? {} : { description: input.description }),
		...(input.roles === undefined ? {} : { roles: defineRoles(...input.roles) }),
		...(input.model === undefined ? {} : { model: defineModel(input.model) }),
		...(input.models === undefined ? {} : { models: defineModels(...input.models) }),
		...(input.sources === undefined ? {} : { sources: { ...input.sources } }),
		tools: defineTools(...(input.tools ?? [])),
		...(input.skills === undefined ? {} : { skills: defineSkill(input.skills) }),
		contextFiles: defineContextFiles(...(input.contextFiles ?? [])),
	};
	const agentFilePath = inferCallingFilePath();
	return setAgentDefinitionMetadata(definition, {
		...(agentFilePath === undefined
			? {}
			: {
					name: basename(dirname(agentFilePath)),
					agentFilePath,
					agentDir: dirname(agentFilePath),
				}),
	});
}
