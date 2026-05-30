import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createDestroySourceTool(channel: HubChannel) {
	return defineTool({
		name: "destroy_source",
		label: "Destroy Source",
		description: "Destroy a source. All agents must unsubscribe before the source can be destroyed.",
		parameters: Type.Object({
			name: Type.String({ description: "Name of the source to destroy" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.destroySource(params.name);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to destroy source: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Source "${params.name}" destroyed` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to destroy source: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
