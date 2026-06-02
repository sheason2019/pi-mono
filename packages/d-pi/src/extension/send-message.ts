import { Type } from "@sheason/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createSendMessageTool(channel: HubChannel) {
	return defineTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to another agent in the network. The target agent will receive the message as input. This is asynchronous — the tool returns immediately and does not wait for a reply.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "ID or name of the target agent" }),
			message: Type.String({ description: "Message content to send" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await channel.sendMessage(params.agent_id, params.message);
				return {
					content: [
						{
							type: "text" as const,
							text: `Message sent to agent ${params.agent_id}. Result: ${JSON.stringify(result)}`,
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
