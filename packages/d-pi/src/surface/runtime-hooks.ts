import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface DPiSetModelHookInput {
	modelId: string;
}

export interface DPiSetThinkingLevelHookInput {
	level: ThinkingLevel;
}

export type DPiRuntimeHookEvent =
	| ({ type: "setModel" } & DPiSetModelHookInput)
	| ({ type: "setThinkingLevel" } & DPiSetThinkingLevelHookInput);

export interface DPiRuntimeHookHandlers {
	setModel?: (event: { type: "setModel" } & DPiSetModelHookInput) => Promise<void> | void;
	setThinkingLevel?: (event: { type: "setThinkingLevel" } & DPiSetThinkingLevelHookInput) => Promise<void> | void;
}

export interface DPiRuntimeHooks {
	setModel(input: DPiSetModelHookInput): Promise<void>;
	setThinkingLevel(input: DPiSetThinkingLevelHookInput): Promise<void>;
}

export function createDPiRuntimeHooks(handlers: DPiRuntimeHookHandlers): DPiRuntimeHooks {
	return {
		async setModel(input) {
			await handlers.setModel?.({ type: "setModel", ...input });
		},
		async setThinkingLevel(input) {
			await handlers.setThinkingLevel?.({ type: "setThinkingLevel", ...input });
		},
	};
}
