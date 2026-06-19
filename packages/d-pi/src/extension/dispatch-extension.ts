import type { ExtensionFactory } from "./contracts.ts";
import { createDispatchTools } from "./dispatch-tools.ts";
import type { HubChannel } from "./hub-channel.ts";

/**
 * Dispatch extension.
 *
 * Provides the `dispatch_*` family of tools (dispatch_bash, dispatch_read,
 * dispatch_edit, etc.) that unify local and remote tool execution.
 *
 * Without `connect_id`: runs locally on the hub host.
 * With `connect_id`: dispatches to the specified connected client.
 *
 * The built-in interactive runtime tools are disabled via excludeTools in
 * the agent-worker, so agents only see the dispatch_* family.
 */
export function createDispatchExtension(channel: HubChannel, cwd: string): ExtensionFactory {
	return (pi) => {
		for (const tool of createDispatchTools(channel, cwd)) {
			pi.registerTool(tool);
		}
	};
}
