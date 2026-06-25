import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";

export interface ExtensionCommandContext {
	cwd: string;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	shutdown(): void;
}

export interface ExtensionContext {
	cwd: string;
	hasUI?: boolean;
	modelRegistry?: ModelRegistry;
}

export type InputSource = "interactive" | "paste" | "programmatic" | (string & {});

export interface InputEvent {
	type: "input";
	text: string;
	source: InputSource;
	streamingBehavior?: "steer" | "followUp" | "next";
}

export type InputEventResult = { action: "continue" } | { action: "handled" };

export type ExtensionHandler<TEvent = unknown, TResult = unknown> = (
	event: TEvent,
	ctx: ExtensionContext,
) => TResult | Promise<TResult>;

export type ExtensionMessageContentPart =
	| { type: "text"; text: string }
	| { type: "image"; data?: string; url?: string; mediaType?: string };

export interface ExtensionMessage {
	role?: string;
	customType?: string;
	content: string | ExtensionMessageContentPart[];
	display?: boolean;
	details?: unknown;
	timestamp?: number;
}

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<TDetails = unknown> = (
	message: ExtensionMessage & { details?: TDetails },
	options: MessageRenderOptions,
	theme: {
		bg(name: string, text: string): string;
		fg(name: string, text: string): string;
	},
) => Component | undefined;

export interface ExtensionAPI {
	registerTool(tool: ToolDefinition): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
		},
	): void;
	registerMessageRenderer<TDetails>(customType: string, renderer: MessageRenderer<TDetails>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: string, handler: ExtensionHandler): void;
	sendMessage(
		message: ExtensionMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "next" },
	): void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void;

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	prepareArguments?: (args: unknown) => Static<TParams>;
	executionMode?: "sequential" | "parallel";
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
		ctx?: ExtensionContext & { modelRegistry: ModelRegistry },
	) => Promise<AgentToolResult<TDetails> & { isError?: boolean; state?: TState }>;
}

export interface ResourceLoader {
	getSkills(): { skills: Array<{ name: string; filePath?: string }>; diagnostics: unknown[] };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getPrompts(): { prompts: unknown[]; diagnostics: unknown[] };
	getThemes(): { themes: unknown[]; diagnostics: unknown[] };
	getExtensions(): { extensions: unknown[]; errors: unknown[]; runtime: unknown };
	extendResources(resources: unknown): void;
	reload(): Promise<void>;
}

export interface ModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable?(): Promise<Model<Api>[]>;
	refresh(): void;
	getError?(): unknown;
}
