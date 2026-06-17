import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { SourceInfo } from "../types.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createGetSourceTool(channel: HubChannel) {
	return defineTool({
		name: "get_source",
		label: "Get Source",
		description:
			"Get one source by name or list all sources. Source names are stable IDs. The returned source info includes subscribers as agent names.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Source ID/name. Omit to list all sources." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.getSource(params.name);
				const result = raw as { source?: SourceInfo; sources?: SourceInfo[]; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to get source: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get source: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
