import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createSubscribeSourceTool(channel: HubChannel) {
	return defineTool({
		name: "subscribe_source",
		label: "Subscribe Source",
		description:
			"Subscribe this agent to a source. The agent will receive all output from the source as incoming messages. Use unsubscribe_source to stop receiving.",
		parameters: Type.Object({
			source_name: Type.String({ description: "Name of the source to subscribe to" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.subscribeSource(params.source_name);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to subscribe: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Subscribed to source "${params.source_name}"` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to subscribe: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
