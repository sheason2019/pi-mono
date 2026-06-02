import { Type } from "@sheason/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createUnsubscribeSourceTool(channel: HubChannel) {
	return defineTool({
		name: "unsubscribe_source",
		label: "Unsubscribe Source",
		description: "Unsubscribe this agent from a source. The agent will no longer receive output from the source.",
		parameters: Type.Object({
			source_name: Type.String({ description: "Name of the source to unsubscribe from" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.unsubscribeSource(params.source_name);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to unsubscribe: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Unsubscribed from source "${params.source_name}"` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to unsubscribe: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
