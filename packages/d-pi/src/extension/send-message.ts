import { Type } from "@sheason/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
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
	return defineTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to another agent in the network. The target agent will receive the message as input. This is asynchronous — the tool returns immediately and does not wait for a reply. Use mode='steer' to interrupt the target's current turn; the default mode='next' queues the message at the start of the target's next turn.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "ID or name of the target agent" }),
			message: Type.String({ description: "Message content to send" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("next"), Type.Literal("steer")], {
					description:
						"Routing mode. 'next' (default) queues at the start of the target's next turn; 'steer' interrupts the current turn. Same vocabulary as the TUI's Enter / Ctrl+Enter.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const mode = params.mode ?? "next";
				const result = await channel.sendMessage(params.agent_id, params.message, mode);
				return {
					content: [
						{
							type: "text" as const,
							text: `Message sent to agent ${params.agent_id} (mode=${mode}). Result: ${JSON.stringify(result)}`,
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
