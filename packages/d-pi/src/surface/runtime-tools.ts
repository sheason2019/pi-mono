import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { DPiRuntimeHooks } from "./runtime-hooks.ts";
import type { DPiTool, DPiToolDetails } from "./tool-surface.ts";
import { defineDPiTool, dPiToolJsonDetails, dPiToolTextResult } from "./tool-surface.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[];

export interface DPiReloadToolSnapshot {
	snapshot: DPiToolDetails;
	details?: DPiToolDetails;
}

export interface CreateDPiReloadToolOptions {
	runtimeHooks?: Pick<DPiRuntimeHooks, "reloadContext">;
	getSnapshot: () => DPiReloadToolSnapshot | Promise<DPiReloadToolSnapshot>;
}

export interface DPiRuntimeModelEntry {
	id: string;
	provider?: string;
}

export interface DPiRuntimeModelResolver {
	find: (provider: string, modelId: string) => DPiRuntimeModelEntry | undefined;
	getAll: () => readonly DPiRuntimeModelEntry[];
}

export interface CreateDPiSetModelToolOptions {
	runtimeHooks: Pick<DPiRuntimeHooks, "setModel">;
	modelResolver: DPiRuntimeModelResolver;
	persistModel?: (modelSpec: string) => void;
	onPersistError?: (message: string) => void;
}

export interface CreateDPiSetThinkingLevelToolOptions {
	runtimeHooks: Pick<DPiRuntimeHooks, "setThinkingLevel">;
	getThinkingLevel: () => ThinkingLevel;
}

export interface CreateDPiRuntimeToolsOptions {
	reload: CreateDPiReloadToolOptions;
	model: CreateDPiSetModelToolOptions;
	thinking: CreateDPiSetThinkingLevelToolOptions;
}

export function createDPiReloadTool(options: CreateDPiReloadToolOptions): DPiTool {
	return defineDPiTool({
		name: "reload",
		label: "Reload Resources",
		description:
			"Reload d-pi resources at runtime without restarting the hub or worker. Returns a JSON snapshot of the post-reload state so the caller can verify what changed. This does NOT re-parse agent.ts for hub wiring changes, does NOT re-read team-template role directories, and those wiring changes still require a hub restart.",
		parameters: Type.Object({}),
		async execute() {
			if (!options.runtimeHooks) {
				return dPiToolErrorResult("Reload not available: d-pi session is not initialized yet.");
			}
			try {
				await options.runtimeHooks.reloadContext({ reason: "tool" });
			} catch (err) {
				return dPiToolErrorResult(`Failed to reload resources: ${errorMessage(err)}`);
			}
			try {
				const snapshot = await options.getSnapshot();
				return dPiToolTextResult(
					JSON.stringify(snapshot.snapshot, null, 2),
					dPiToolJsonDetails(snapshot.details ?? snapshot.snapshot),
				);
			} catch (err) {
				return dPiToolErrorResult(`Failed to read reload snapshot: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiSetModelTool(options: CreateDPiSetModelToolOptions): DPiTool {
	return defineDPiTool({
		name: "set_model",
		label: "Set Model",
		description:
			"Switch this agent's model at runtime for subsequent turns. Accepts a full spec like 'anthropic/claude-sonnet-4' or a bare model id. The switch is applied live and can be persisted by the runtime adapter.",
		parameters: Type.Object({
			model: Type.String({
				description:
					"Model identifier. Preferred form is 'provider/id' (e.g. 'anthropic/claude-sonnet-4'). Bare ids are also accepted and searched across providers.",
			}),
		}),
		async execute(_toolCallId, params) {
			const spec = params.model.trim();
			if (!spec) {
				return dPiToolErrorResult("set_model requires a non-empty 'model' parameter.", { error: "empty_model" });
			}

			try {
				const targetModel = resolveModelSpec(spec, options.modelResolver);
				if (!targetModel) {
					return dPiToolErrorResult(
						`Unknown model spec: ${spec}. Use a known provider/model id or run reload first if you just added a provider to models.json.`,
						{ spec },
					);
				}
			} catch (err) {
				return dPiToolErrorResult(`Failed to resolve model '${spec}': ${errorMessage(err)}`, {
					spec,
					error: errorMessage(err),
				});
			}

			try {
				await options.runtimeHooks.setModel({ modelId: spec });
			} catch (err) {
				return dPiToolErrorResult(`Model switch to ${spec} failed: ${errorMessage(err)}`, {
					spec,
					error: errorMessage(err),
				});
			}

			const details: DPiToolDetails = { model: spec, success: true };
			let persistenceText = "Persistence is not configured for this runtime adapter.";
			if (options.persistModel) {
				try {
					options.persistModel(spec);
					details.persisted = true;
					persistenceText = "Persisted to agent.ts.";
				} catch (err) {
					const persistError = errorMessage(err);
					details.persisted = false;
					details.persistError = persistError;
					options.onPersistError?.(`Failed to persist model='${spec}' to agent.ts: ${persistError}`);
					persistenceText = `Model was not persisted to agent.ts: ${persistError}.`;
				}
			}

			return dPiToolTextResult(
				`Model switched to ${spec}. Subsequent turns will use the new model. ${persistenceText} Call reload if you want the system-prompt identity block to reflect it immediately.`,
				details,
			);
		},
	});
}

export function createDPiSetThinkingLevelTool(options: CreateDPiSetThinkingLevelToolOptions): DPiTool {
	return defineDPiTool({
		name: "set_thinking_level",
		label: "Set Thinking Level",
		description:
			"Set the thinking (reasoning effort) level for this agent. The value is clamped to what the current model supports. Changes take effect for subsequent turns.",
		parameters: Type.Object({
			level: Type.Union(
				THINKING_LEVELS.map((level) => Type.Literal(level)),
				{
					description:
						"Desired thinking level. One of: off, minimal, low, medium, high, xhigh. The effective level will be clamped to the model's capabilities.",
				},
			),
		}),
		async execute(_toolCallId, params) {
			const raw = (params as { level: string }).level.trim().toLowerCase();
			if (!isThinkingLevel(raw)) {
				return dPiToolErrorResult(
					`Invalid thinking level '${raw}'. Must be one of: ${THINKING_LEVELS.join(", ")}.`,
					{
						requested: raw,
						valid: THINKING_LEVELS,
					},
				);
			}
			try {
				await options.runtimeHooks.setThinkingLevel({ level: raw });
			} catch (err) {
				return dPiToolErrorResult(`Failed to set thinking level: ${errorMessage(err)}`, {
					requested: raw,
					error: errorMessage(err),
				});
			}
			const effective = options.getThinkingLevel();
			return dPiToolTextResult(`Thinking level set. Requested='${raw}', effective='${effective}'.`, {
				requested: raw,
				effective,
			});
		},
	});
}

export function createDPiRuntimeTools(options: CreateDPiRuntimeToolsOptions): DPiTool[] {
	return [
		createDPiReloadTool(options.reload),
		createDPiSetModelTool(options.model),
		createDPiSetThinkingLevelTool(options.thinking),
	];
}

function resolveModelSpec(spec: string, resolver: DPiRuntimeModelResolver): DPiRuntimeModelEntry | undefined {
	let targetModel: DPiRuntimeModelEntry | undefined;
	const firstSlash = spec.indexOf("/");
	if (firstSlash >= 0) {
		const provider = spec.slice(0, firstSlash);
		const modelId = spec.slice(firstSlash + 1);
		if (provider && modelId) {
			targetModel = resolver.find(provider, modelId);
		}
	}
	if (!targetModel) {
		targetModel = resolver.getAll().find((model) => model.id === spec);
	}
	return targetModel;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function dPiToolErrorResult(text: string, details: DPiToolDetails = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		isError: true,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
