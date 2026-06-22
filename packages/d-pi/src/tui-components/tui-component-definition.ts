import type { MessageRenderer } from "../extension/contracts.ts";

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
