import type { ExtensionFactory } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";
import { createRemoteTools } from "./remote-tools.ts";

/**
 * Remote executor extension.
 *
 * Provides the `remote_*` family of tools (remote_bash, remote_read, remote_edit, etc.).
 *
 * These tools allow an agent running on the hub (in d-pi worker mode) to execute
 * the corresponding native tools on a *connected* d-pi client machine (the user's
 * laptop / local environment) instead of on the hub host.
 *
 * Dispatch happens over the d-pi IPC channel established when the user runs
 * `d-pi connect` against this agent. If no client executor is bound, the tools
 * return a clear error (the LLM can then fall back to the local built-in tools).
 *
 * This capability is intentionally a separate extension so it can be:
 * - Registered with its own name for diagnostics and tracing (`<d-pi-remote-executor>`)
 * - Potentially enabled/disabled independently in the future
 * - Kept thematically isolated from the multi-agent orchestration surface
 *
 * Only meaningful in worker mode (requires a HubChannel). In client/TUI mode
 * this extension is not used.
 */
export function createRemoteExecutorExtension(channel: HubChannel): ExtensionFactory {
	return (pi) => {
		// `remote_*` tools let the server-side agent invoke native tools on the
		// connected d-pi client's machine via the executor IPC path.
		// They are always registered; the channel itself produces a good error
		// message if no client is currently bound.
		for (const tool of createRemoteTools(channel)) {
			pi.registerTool(tool);
		}
	};
}
