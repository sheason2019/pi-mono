import type { DPiToolDetails } from "../surface/index.ts";
import { createDPiReloadTool } from "../surface/index.ts";
import type { ExtensionAPI, ModelRegistry, ResourceLoader, ToolDefinition } from "./contracts.ts";

/**
 * Lazy accessors for the d-pi session's reload capability.
 *
 * Both getters may resolve to `undefined` when the worker has not yet
 * constructed the runtime session. The tool
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
 * The tool calls the worker session's reload hook (re-reading
 * skills, system prompt, AGENTS.md / CLAUDE.md context files,
 * extensions), then queries the resource loader for the post-reload
 * state and returns a JSON snapshot to the LLM so it can confirm what
 * changed. If a `getModelRegistry` dep is provided, it also calls
 * `ModelRegistry.refresh()` afterwards so that edits to
 * `~/.pi/agent/models.json` (new provider, rotated apiKey) are visible
 * without a hub restart.
 */
export function createReloadTools(deps: ReloadToolsDeps): ToolDefinition {
	const tool = createDPiReloadTool({
		runtimeHooks: {
			reloadContext: async () => {
				const reloadFn = deps.getReloadFn();
				if (!reloadFn) {
					throw new Error("Reload not available: d-pi session is not initialized yet.");
				}
				await reloadFn();
			},
		},
		getSnapshot: () => createReloadSnapshot(deps),
	});
	return tool as ToolDefinition;
}

function createReloadSnapshot(deps: ReloadToolsDeps): { snapshot: DPiToolDetails; details: DPiToolDetails } {
	// Re-resolve the loader AFTER reload so the snapshot reflects the freshly reloaded state.
	const resourceLoader = deps.getResourceLoader();
	if (!resourceLoader) {
		throw new Error("Reload completed, but the resource loader is no longer available.");
	}
	const skills = resourceLoader.getSkills().skills;
	const systemPrompt = resourceLoader.getSystemPrompt();
	const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
	const contextFiles = resourceLoader.getAgentsFiles().agentsFiles;

	const snapshot: DPiToolDetails = {
		skills: skills.length,
		skillNames: skills.map((skill) => skill.name),
		systemPromptLen: systemPrompt?.length ?? 0,
		appendSystemPromptCount: appendSystemPrompt.length,
		contextFiles: contextFiles.length,
		contextFilePaths: contextFiles.map((file) => file.path),
	};
	const details: DPiToolDetails = {
		skills: skills.length,
		systemPromptLen: systemPrompt?.length ?? 0,
		contextFiles: contextFiles.length,
	};

	const modelRegistry = deps.getModelRegistry?.();
	if (!modelRegistry) {
		return { snapshot, details };
	}

	try {
		modelRegistry.refresh();
		const modelsCount = modelRegistry.getAll().length;
		snapshot.models = modelsCount;
		details.models = modelsCount;
	} catch (err) {
		const modelsError = err instanceof Error ? err.message : String(err);
		snapshot.modelsError = modelsError;
		details.modelsError = modelsError;
	}
	return { snapshot, details };
}

/**
 * Extension factory that registers the reload tool on the pi api.
 *
 * The factory itself is safe to call before the runtime session exists — the
 * tool is registered unconditionally, and the "session not ready" path is
 * handled inside the tool's execute().
 */
export function createReloadExtension(deps: ReloadToolsDeps): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool(createReloadTools(deps));
	};
}
