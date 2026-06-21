import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface DPiReloadContextHookInput {
	reason?: string;
}

export interface DPiSetModelHookInput {
	modelId: string;
}

export interface DPiSetThinkingLevelHookInput {
	level: ThinkingLevel;
}

export type DPiRuntimeHookEvent =
	| ({ type: "reloadContext" } & DPiReloadContextHookInput)
	| ({ type: "setModel" } & DPiSetModelHookInput)
	| ({ type: "setThinkingLevel" } & DPiSetThinkingLevelHookInput);

export interface DPiRuntimeHookHandlers {
	reloadContext?: (event: { type: "reloadContext" } & DPiReloadContextHookInput) => Promise<void> | void;
	setModel?: (event: { type: "setModel" } & DPiSetModelHookInput) => Promise<void> | void;
	setThinkingLevel?: (event: { type: "setThinkingLevel" } & DPiSetThinkingLevelHookInput) => Promise<void> | void;
}

export interface DPiRuntimeHooks {
	reloadContext(input?: DPiReloadContextHookInput): Promise<void>;
	setModel(input: DPiSetModelHookInput): Promise<void>;
	setThinkingLevel(input: DPiSetThinkingLevelHookInput): Promise<void>;
}

export function createDPiRuntimeHooks(handlers: DPiRuntimeHookHandlers): DPiRuntimeHooks {
	return {
		async reloadContext(input = {}) {
			await handlers.reloadContext?.({ type: "reloadContext", ...input });
		},
		async setModel(input) {
			await handlers.setModel?.({ type: "setModel", ...input });
		},
		async setThinkingLevel(input) {
			await handlers.setThinkingLevel?.({ type: "setThinkingLevel", ...input });
		},
	};
}
