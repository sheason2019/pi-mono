import type { Component } from "@earendil-works/pi-tui";

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

export interface AgentTuiCustomMessage<T = unknown> {
	customType: string;
	content: unknown;
	display?: boolean;
	details?: T;
}

export interface AgentTuiRenderOptions {
	expanded: boolean;
}

export interface AgentTuiTheme {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
}

export type AgentTuiComponentRenderer<T = unknown> = (
	message: AgentTuiCustomMessage<T>,
	options: AgentTuiRenderOptions,
	theme: AgentTuiTheme,
) => Component | undefined;

export interface AgentTuiComponentDefinition<T = unknown> {
	customType: string;
	render: AgentTuiComponentRenderer<T>;
}

export interface AgentDefinition {
	/** Imported parent agent definition. This builds topology only; it does not imply inheritance. */
	parent?: AgentDefinition;
	description?: string;
	roles?: string[];
	model?: AgentModelDefinition;
	tools: AgentToolDefinition[];
	tuiComponents?: AgentTuiComponentDefinition[];
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

export function defineTuiComponent<T = unknown>(input: AgentTuiComponentDefinition<T>): AgentTuiComponentDefinition<T> {
	return input;
}

export function defineAgent(input: AgentDefinition): AgentDefinition {
	return input;
}
