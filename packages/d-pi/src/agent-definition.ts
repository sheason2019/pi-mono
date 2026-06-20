import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentToolDefinition {
	name: string;
}

export interface AgentSkillDefinition {
	dir: string;
}

export interface AgentContextFileDefinition {
	type: "context" | "append_system";
	path: string;
}

export interface AgentModelDefinition {
	provider: string;
	name: string;
}

export type AgentRoleDefinition = string;

export interface AgentDefinitionInput {
	/** Imported parent agent definition. This builds topology only; it does not imply inheritance. */
	parent?: AgentDefinition;
	description?: string;
	roles?: AgentRoleDefinition[];
	model?: AgentModelDefinition;
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
	tools: AgentToolDefinition[];
	skills: AgentSkillDefinition;
	contextFiles: AgentContextFileDefinition[];
}

const DEFAULT_AGENT_SKILL: AgentSkillDefinition = { dir: "./skills" };
const DEFAULT_AGENT_CONTEXT_FILES: AgentContextFileDefinition[] = [
	{ type: "context", path: "./AGENTS.md" },
	{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
];
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

export function defineTool(input: AgentToolDefinition): AgentToolDefinition {
	return { name: input.name };
}

export function defineTools(...input: AgentToolDefinition[]): AgentToolDefinition[] {
	return input.map(defineTool);
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

export function defineModel(input: AgentModelDefinition): AgentModelDefinition {
	return { provider: input.provider, name: input.name };
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
		tools: defineTools(...(input.tools ?? [])),
		skills: defineSkill(input.skills ?? DEFAULT_AGENT_SKILL),
		contextFiles: defineContextFiles(...(input.contextFiles ?? DEFAULT_AGENT_CONTEXT_FILES)),
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
