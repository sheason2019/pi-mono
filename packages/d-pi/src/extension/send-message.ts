import { createDPiSendMessageTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

/**
 * Send a message to another agent in the network.
 *
 * Routing uses the same mode vocabulary as the user-facing TUI:
 *   - `mode: "next"`  (default) — queue at the start of the target
 *     agent's next turn, equivalent to pressing Enter in the TUI.
 *   - `mode: "steer"` — interrupt the target agent's current turn
 *     and inject immediately, equivalent to Ctrl+Enter in the TUI.
 *
 * The tool exposes only the user-facing `mode` parameter; the internal
 * deliverAs / triggerTurn / drainMode routing is handled inside the
 * channel and extension. This keeps the tool surface area aligned
 * with the TUI mental model so agents calling `send_message` don't
 * need to know about internal queue mechanics.
 */
export function createSendMessageTool(channel: HubChannel) {
	return createDPiSendMessageTool(createHubActionsClientFromHubChannel(channel), { agentName: channel.agentName });
}
