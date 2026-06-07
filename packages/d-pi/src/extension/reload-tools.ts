import { Type } from "@sheason/pi-ai";
import type { ExtensionAPI, ResourceLoader, ToolDefinition } from "@sheason/pi-coding-agent";
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
}

/**
 * Create the `reload_resources` LLM-callable tool.
 *
 * The tool calls the worker's `AgentSession.reload()` (re-reading skills,
 * system prompt, context files, extensions), then queries the resource
 * loader for the post-reload state and returns a JSON snapshot to the
 * LLM so it can confirm what changed.
 */
export function createReloadTools(deps: ReloadToolsDeps): ToolDefinition {
	return defineTool({
		name: "reload_resources",
		label: "Reload Resources",
		description:
			"Reload d-pi resources (skills, system prompt, AGENTS.md / CLAUDE.md context files, extensions) at runtime without restarting the hub or worker. Returns a JSON snapshot of the post-reload state so the caller can verify what changed. Takes effect on the next agent turn — the in-flight turn is aborted.",
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
			const snapshot = {
				skills: skills.length,
				skillNames: skills.map((s) => s.name),
				systemPromptLen: systemPrompt?.length ?? 0,
				appendSystemPromptCount: appendSystemPrompt.length,
				contextFiles: contextFiles.length,
				contextFilePaths: contextFiles.map((f) => f.path),
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }],
				details: {
					skills: snapshot.skills,
					systemPromptLen: snapshot.systemPromptLen,
					contextFiles: snapshot.contextFiles,
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
