import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ModelRegistry,
	ResourceLoader,
	ToolDefinition,
} from "@sheason/pi-coding-agent";
import { defineTool } from "@sheason/pi-coding-agent";

/**
 * Lazy accessors for the d-pi session's reload capability.
 *
 * Both getters may resolve to `undefined` when the worker has not yet
 * constructed the AgentSession (e.g. during the first
 * `resourceLoader.reload()` inside `createAgentSessionServices`). The tool
 * uses these to defer resolution to `execute()` time so it is safe to
 * register the tool eagerly.
 */
export interface ReloadToolsDeps {
	getReloadFn: () => (() => Promise<void>) | undefined;
	getResourceLoader: () => ResourceLoader | undefined;
	/**
	 * Optional ModelRegistry for the worker's session. When provided,
	 * the `reload` tool also calls `modelRegistry.refresh()` after the
	 * resource reload so edits to `~/.pi/agent/models.json` (adding a
	 * new provider, rotating an apiKey, etc.) take effect without a
	 * hub restart. The dependency is optional so the tool stays
	 * usable in the d-pi client (TUI) mode where there is no
	 * worker-owned model registry to refresh.
	 */
	getModelRegistry?: () => ModelRegistry | undefined;
}

/**
 * Create the `reload` LLM-callable tool.
 *
 * The tool calls the worker's `AgentSession.reload()` (re-reading
 * skills, system prompt, AGENTS.md / CLAUDE.md context files,
 * extensions), then queries the resource loader for the post-reload
 * state and returns a JSON snapshot to the LLM so it can confirm what
 * changed. If a `getModelRegistry` dep is provided, it also calls
 * `ModelRegistry.refresh()` afterwards so that edits to
 * `~/.pi/agent/models.json` (new provider, rotated apiKey) are visible
 * without a hub restart.
 */
export function createReloadTools(deps: ReloadToolsDeps): ToolDefinition {
	return defineTool({
		name: "reload",
		label: "Reload Resources",
		description:
			"Reload d-pi resources (skills, system prompt, AGENTS.md / CLAUDE.md context files, extensions) at runtime without restarting the hub or worker. Also re-reads ~/.pi/agent/models.json so newly added providers / models become available in the same call, and re-reads the workspace-level APPEND_SYSTEM.md plus this agent's agent.json so changes to the ## Agent identity section (description / roles / model name / tool allow-deny list) take effect. Returns a JSON snapshot of the post-reload state so the caller can verify what changed. Takes effect on the next agent turn — the in-flight turn is aborted. Does NOT re-parse agents/<name>/agent.json for non-identity fields that affect hub-level wiring (parentName changes, agent rename, port allocation — these require a hub restart) and does NOT re-read group-architecture role directories beyond the AGENTS.md / skills / extensions already wired in (require destroy + recreate or hub restart).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const reloadFn = deps.getReloadFn();
			if (!reloadFn) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Reload not available: d-pi session is not initialized yet.",
						},
					],
					details: {},
					isError: true,
				};
			}
			try {
				await reloadFn();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reload resources: ${message}` }],
					details: {},
					isError: true,
				};
			}
			// Re-resolve the resource loader AFTER reload so the snapshot
			// reflects the freshly reloaded state. Reload rebuilds the
			// session's internal tool / extension registry, so the loader
			// reference captured before reload would be stale.
			const resourceLoader = deps.getResourceLoader();
			if (!resourceLoader) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Reload completed, but the resource loader is no longer available.",
						},
					],
					details: {},
					isError: true,
				};
			}
			const skills = resourceLoader.getSkills().skills;
			const systemPrompt = resourceLoader.getSystemPrompt();
			const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
			const contextFiles = resourceLoader.getAgentsFiles().agentsFiles;

			// Also re-read ~/.pi/agent/models.json so newly added
			// providers/models become available without a hub restart.
			// The dependency is optional — in client (TUI) mode there is
			// no worker-owned model registry to refresh, and refresh()
			// is a no-op safe to skip. When refresh throws (e.g. invalid
			// models.json schema) we surface the error in the snapshot
			// rather than failing the whole reload, because the resource
			// side already succeeded.
			const modelRegistry = deps.getModelRegistry?.();
			let modelsCount: number | undefined;
			let modelsError: string | undefined;
			if (modelRegistry) {
				try {
					modelRegistry.refresh();
					modelsCount = modelRegistry.getAll().length;
				} catch (err) {
					modelsError = err instanceof Error ? err.message : String(err);
				}
			}

			const snapshot: Record<string, unknown> = {
				skills: skills.length,
				skillNames: skills.map((s) => s.name),
				systemPromptLen: systemPrompt?.length ?? 0,
				appendSystemPromptCount: appendSystemPrompt.length,
				contextFiles: contextFiles.length,
				contextFilePaths: contextFiles.map((f) => f.path),
			};
			if (modelsCount !== undefined) {
				snapshot.models = modelsCount;
			}
			if (modelsError !== undefined) {
				snapshot.modelsError = modelsError;
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }],
				details: {
					skills: skills.length,
					systemPromptLen: systemPrompt?.length ?? 0,
					contextFiles: contextFiles.length,
					models: modelsCount,
					modelsError,
				},
			};
		},
	});
}

/**
 * Extension factory that registers the reload tool on the pi api.
 *
 * The factory itself is safe to call before the AgentSession exists — the
 * tool is registered unconditionally, and the "session not ready" path is
 * handled inside the tool's execute().
 */
export function createReloadExtension(deps: ReloadToolsDeps): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool(createReloadTools(deps));
	};
}
