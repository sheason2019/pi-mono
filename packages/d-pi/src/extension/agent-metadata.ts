import type { Api, Model } from "@earendil-works/pi-ai";
import { persistModelInAgentTs } from "../agent-config.ts";
import {
	createDPiSetModelTool,
	createDPiSetThinkingLevelTool,
	type DPiRuntimeModelEntry,
	type DPiRuntimeModelResolver,
} from "../surface/index.ts";
import type { ExtensionAPI, ModelRegistry, ToolDefinition } from "./contracts.ts";
import { createReloadTools, type ReloadToolsDeps } from "./reload-tools.ts";

/**
 * d-pi agent metadata control extension.
 *
 * Consolidates:
 * - The `reload` tool (moved from the previous dedicated reload extension).
 * - `set_model`: allows an agent (via LLM tool call) to switch its active model at runtime.
 * - `set_thinking_level`: allows switching thinking intensity (clamped to model capabilities).
 *
 * This is one of the built-in d-pi extensions loaded into every managed agent's
 * session (alongside the main orchestration extension). It is registered as a
 * separate ExtensionFactory so its deps (especially the lazy reload accessors)
 * can be wired after the runtime session exists.
 *
 * Model switches are applied to the live session (subsequent turns use the new
 * model) and persisted to the agent's `agent.ts` so that:
 * - The "## Agent identity" block reflects the new model after reload.
 * - Future worker restarts (via hub) pick up the preferred model from the config.
 *
 * Thinking level is a per-session concern (not stored in agent.ts).
 *
 * The tools delegate to the underlying ExtensionAPI (pi.setModel /
 * pi.setThinkingLevel) passed to every extension factory.
 *
 * Model changes are persisted to agent.ts (restarts + identity block see
 * them). No live IPC model update to hub AgentRegistry yet, so
 * team may be stale until recreate (P1 gap). ctx.cwd for the
 * write is the d-pi per-agent dir (see agent-worker persistSessionId); P2.
 */

export type AgentMetadataToolsDeps = ReloadToolsDeps & {
	/** Return the authoritative per-agent directory that contains this agent's agent.ts.
	 *  In d-pi worker this is the `cwd` from AgentWorkerConfig (the directory the worker
	 *  was spawned for). Falls back to ctx.cwd if not provided. This avoids relying on
	 *  ExtensionContext.cwd for a write that must target the persisted agent config.
	 */
	getAgentCwd?: () => string | undefined;
};

/**
 * Create the combined agent-metadata extension factory.
 */
export function createAgentMetadataExtension(deps: AgentMetadataToolsDeps): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const getThinkingLevel = pi.getThinkingLevel.bind(pi);
		const setThinkingLevel = pi.setThinkingLevel.bind(pi);

		// 1. Reload tool (moved here from the dedicated reload extension).
		// The implementation and lazy dep contract are unchanged.
		pi.registerTool(createReloadTools(deps));

		// 2. set_model — switch the agent's active model at runtime.
		pi.registerTool(createSetModelRuntimeTool(pi, deps));

		// 3. set_thinking_level — switch thinking intensity (clamped server-side to what the current model supports).
		const thinkingTool = createDPiSetThinkingLevelTool({
			runtimeHooks: {
				setThinkingLevel: async ({ level }) => {
					setThinkingLevel(level);
				},
			},
			getThinkingLevel,
		});
		pi.registerTool(thinkingTool as ToolDefinition);
	};
}

function createSetModelRuntimeTool(pi: ExtensionAPI, deps: AgentMetadataToolsDeps): ToolDefinition {
	const setModel = pi.setModel.bind(pi);
	const baseTool = createDPiSetModelTool({
		runtimeHooks: {
			setModel: async () => {},
		},
		modelResolver: {
			find: () => undefined,
			getAll: () => [],
		},
	});

	const runtimeTool: ToolDefinition = {
		...baseTool,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx?.modelRegistry) {
				throw new Error("Model registry is unavailable.");
			}
			let providerResolvedModel: Model<Api> | undefined;
			const modelsById = new Map<string, Model<Api>>();
			const resolver = createRuntimeModelResolver(ctx.modelRegistry, modelsById, (model) => {
				providerResolvedModel = model;
			});
			const surfaceTool = createDPiSetModelTool({
				runtimeHooks: {
					setModel: async ({ modelId }) => {
						const targetModel = providerResolvedModel ?? modelsById.get(modelId);
						if (!targetModel) {
							throw new Error(`Unknown model spec: ${modelId}.`);
						}
						const success = await setModel(targetModel);
						if (!success) {
							throw new Error("reported failure (likely missing credentials for the provider).");
						}
					},
				},
				modelResolver: resolver,
				persistModel: async (modelSpec) => {
					const agentDir = deps.getAgentCwd ? deps.getAgentCwd() : undefined;
					await persistModelInAgentTs(agentDir || ctx.cwd, modelSpec);
				},
				onPersistError: (message) => {
					process.stderr.write(`[d-pi agent-metadata] ${message}\n`);
				},
			});
			return surfaceTool.execute(toolCallId, params as { model: string }, signal);
		},
	};
	return runtimeTool;
}

function createRuntimeModelResolver(
	modelRegistry: ModelRegistry,
	modelsById: Map<string, Model<Api>>,
	onProviderResolved: (model: Model<Api>) => void,
): DPiRuntimeModelResolver {
	return {
		find: (provider, modelId) => {
			const model = modelRegistry.find(provider, modelId);
			if (!model) {
				return undefined;
			}
			onProviderResolved(model);
			modelsById.set(model.id, model);
			return toRuntimeModelEntry(model);
		},
		getAll: () => {
			const models = modelRegistry.getAll();
			for (const model of models) {
				if (!modelsById.has(model.id)) {
					modelsById.set(model.id, model);
				}
			}
			return models.map((model) => toRuntimeModelEntry(model));
		},
	};
}

function toRuntimeModelEntry(model: Model<Api>): DPiRuntimeModelEntry {
	return { id: model.id, provider: model.provider };
}

// Re-export the reload building blocks so existing tests and any external
// direct usage of the reload tool factory continue to work without change.
export { createReloadTools, type ReloadToolsDeps } from "./reload-tools.ts";
