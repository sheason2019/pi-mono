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

export interface AgentDefinition {
	/** Imported parent agent definition. This builds topology only; it does not imply inheritance. */
	parent?: AgentDefinition;
	description?: string;
	roles?: string[];
	model?: AgentModelDefinition;
	tools: AgentToolDefinition[];
	skills: AgentSkillDefinition;
	contextFiles: AgentContextFileDefinition[];
}

export function defineTool(input: AgentToolDefinition): AgentToolDefinition {
	return input;
}

export function defineSkill(input: AgentSkillDefinition): AgentSkillDefinition {
	return input;
}

export function defineContextFile(input: AgentContextFileDefinition): AgentContextFileDefinition {
	return input;
}

export function defineModel(input: AgentModelDefinition): AgentModelDefinition {
	return input;
}

export function defineAgent(input: AgentDefinition): AgentDefinition {
	return input;
}
