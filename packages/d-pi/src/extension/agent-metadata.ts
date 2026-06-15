import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@sheason/pi-coding-agent";
import { defineTool } from "@sheason/pi-coding-agent";
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
 * can be wired after the AgentSession exists (same pattern as the old reload).
 *
 * Model switches are applied to the live session (subsequent turns use the new
 * model) and persisted to the agent's `agent.json` so that:
 * - The "## Agent identity" block reflects the new model after reload.
 * - Future worker restarts (via hub) pick up the preferred model from the config.
 *
 * Thinking level is a per-session concern (not stored in agent.json).
 *
 * In this phase we intentionally keep the surface small: the tools delegate to
 * the underlying ExtensionAPI (pi.setModel / pi.setThinkingLevel) which is
 * available on the ExtensionAPI passed to every extension factory.
 *
 * Model changes are persisted to agent.json (restarts + identity block see
 * them). No live IPC model update to hub AgentRegistry yet, so
 * group_architecture may be stale until recreate (P1 gap). ctx.cwd for the
 * write is the d-pi per-agent dir (see agent-worker persistSessionId); P2.
 */

export type AgentMetadataToolsDeps = ReloadToolsDeps;

/**
 * Create the combined agent-metadata extension factory.
 * Pass the same lazy deps that the old reload extension used.
 */
export function createAgentMetadataExtension(deps: AgentMetadataToolsDeps): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		// Capture the model/thinking control methods from the ExtensionAPI.
		// These are stable for the lifetime of this extension instance.
		// setModel returns Promise<boolean> (false if no credentials for the target model).
		const setModel = pi.setModel.bind(pi);
		const getThinkingLevel = pi.getThinkingLevel.bind(pi);
		const setThinkingLevel = pi.setThinkingLevel.bind(pi);

		// 1. Reload tool (moved here from the dedicated reload extension).
		// The implementation and lazy dep contract are unchanged.
		pi.registerTool(createReloadTools(deps));

		// 2. set_model — switch the agent's active model at runtime.
		pi.registerTool(
			defineTool({
				name: "set_model",
				label: "Set Model",
				description:
					"Switch this agent's model at runtime for subsequent turns. Accepts a full spec like 'anthropic/claude-sonnet-4' or a bare model id. The model is resolved from the current ModelRegistry (including ~/.pi/agent/models.json). The switch is applied live to the session and persisted to this agent's agent.json so the ## Agent identity section and future restarts see the new default. Returns whether the switch succeeded (may be false if no API key/credentials are available for the target provider). Does not reload resources — call the reload tool afterwards if you want the identity block in the system prompt to update immediately.",
				parameters: Type.Object({
					model: Type.String({
						description:
							"Model identifier. Preferred form is 'provider/id' (e.g. 'anthropic/claude-sonnet-4'). Bare ids are also accepted and searched across providers.",
					}),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const spec = (params as { model: string }).model.trim();
					if (!spec) {
						return {
							content: [{ type: "text" as const, text: "set_model requires a non-empty 'model' parameter." }],
							details: { error: "empty_model" },
							isError: true,
						};
					}

					const registry: ModelRegistry = ctx.modelRegistry;
					let targetModel: Model<any> | undefined;

					try {
						if (spec.includes("/")) {
							const [provider, id] = spec.split("/", 2);
							if (provider && id) {
								targetModel = registry.find(provider, id);
							}
						}
						if (!targetModel) {
							// Fallback: search by bare id across the registry (matches worker startup logic)
							const all = registry.getAll();
							targetModel = all.find((m: Model<any>) => m.id === spec);
						}
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						return {
							content: [{ type: "text" as const, text: `Failed to resolve model '${spec}': ${msg}` }],
							details: { spec, error: msg },
							isError: true,
						};
					}

					if (!targetModel) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Unknown model spec: ${spec}. Use a known provider/model id or run reload first if you just added a provider to models.json.`,
								},
							],
							details: { spec },
							isError: true,
						};
					}

					let success = false;
					try {
						success = await setModel(targetModel);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						return {
							content: [{ type: "text" as const, text: `Model switch to ${spec} failed: ${msg}` }],
							details: { spec, error: msg },
							isError: true,
						};
					}

					// Persist the chosen spec into this agent's agent.json so that:
					// - The "## Agent identity" block (re-injected on reload via the workspace override) shows the new model.
					// - The next time the hub spawns a worker for this agent it will see the updated model in config.
					// We only touch the file if it already exists (the worker always has one for real d-pi agents).
					if (success) {
						try {
							const cfgPath = join(ctx.cwd, "agent.json");
							const raw = readFileSync(cfgPath, "utf-8");
							const cfg = JSON.parse(raw) as Record<string, unknown>;
							cfg.model = spec;
							writeFileSync(cfgPath, `${JSON.stringify(cfg, null, "\t")}\n`);
						} catch {
							// Non-fatal: live session model is already switched. Identity will be stale until manual edit or reload that happens to rewrite the file.
						}
					}

					return {
						content: [
							{
								type: "text" as const,
								text: success
									? `Model switched to ${spec}. Subsequent turns will use the new model. Persisted to agent.json. Call reload if you want the system-prompt identity block to reflect it immediately.`
									: `Model switch to ${spec} reported failure (likely missing credentials for the provider).`,
							},
						],
						details: { model: spec, success },
					};
				},
			}),
		);

		// 3. set_thinking_level — switch thinking intensity (clamped server-side to what the current model supports).
		// Schema uses a closed union of literals so the LLM receives an enum in the tool schema
		// and is less likely to invent invalid values. We still validate at runtime and return a
		// clear error (with the valid list) if an out-of-range value arrives.
		const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
		pi.registerTool(
			defineTool({
				name: "set_thinking_level",
				label: "Set Thinking Level",
				description:
					"Set the thinking (reasoning effort) level for this agent. The value is clamped to what the current model supports (off, minimal, low, medium, high, xhigh). Changes take effect for subsequent turns. Thinking level is a session-level setting and is not written to agent.json (unlike model).",
				parameters: Type.Object({
					level: Type.Union(
						THINKING_LEVELS.map((l) => Type.Literal(l)),
						{
							description:
								"Desired thinking level. One of: off, minimal, low, medium, high, xhigh. The effective level will be clamped to the model's capabilities.",
						},
					),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
					const raw = (params as { level: string }).level.trim().toLowerCase();
					if (!THINKING_LEVELS.includes(raw as ThinkingLevel)) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Invalid thinking level '${raw}'. Must be one of: ${THINKING_LEVELS.join(", ")}.`,
								},
							],
							details: { requested: raw, valid: THINKING_LEVELS },
							isError: true,
						};
					}
					const level = raw as ThinkingLevel;
					try {
						setThinkingLevel(level);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						return {
							content: [{ type: "text" as const, text: `Failed to set thinking level: ${msg}` }],
							details: { requested: level, error: msg },
							isError: true,
						};
					}
					const effective = getThinkingLevel();
					return {
						content: [
							{
								type: "text" as const,
								text: `Thinking level set. Requested='${level}', effective='${effective}'.`,
							},
						],
						details: { requested: level, effective },
					};
				},
			}),
		);
	};
}

// Re-export the reload building blocks so existing tests and any external
// direct usage of the reload tool factory continue to work without change.
export { createReloadTools, type ReloadToolsDeps } from "./reload-tools.ts";
