import type { Component } from "@earendil-works/pi-tui";

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

export interface AgentTuiComponentDefinition<TDetails = unknown> {
	customType: string;
	render: MessageRenderer<TDetails>;
}

export interface AgentTuiComponentDefinitionInput<TDetails = unknown> {
	customType: string;
	render: MessageRenderer<TDetails>;
}

export function defineTuiComponent<TDetails = unknown>(
	input: AgentTuiComponentDefinitionInput<TDetails>,
): AgentTuiComponentDefinition<TDetails> {
	if (typeof input.customType !== "string" || input.customType.trim().length === 0) {
		throw new TypeError("defineTuiComponent requires a non-empty customType");
	}
	if (typeof input.render !== "function") {
		throw new TypeError("defineTuiComponent requires a render function");
	}
	return {
		customType: input.customType,
		render: input.render,
	};
}
