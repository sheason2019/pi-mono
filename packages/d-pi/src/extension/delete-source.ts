import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createDeleteSourceTool(channel: HubChannel) {
	return defineTool({
		name: "delete_source",
		label: "Delete Source",
		description:
			"Delete a source by name. Source names are stable IDs. Deleting a source stops the supervised process, removes its persisted source.json, and clears its subscribers in one operation.",
		parameters: Type.Object({
			name: Type.String({ description: "Source ID/name to delete" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.deleteSource(params.name);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to delete source: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Source "${params.name}" deleted.` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to delete source: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
