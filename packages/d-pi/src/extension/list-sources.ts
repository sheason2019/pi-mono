import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { SourceInfo } from "../types.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createListSourcesTool(channel: HubChannel) {
	return defineTool({
		name: "list_sources",
		label: "List Sources",
		description: "List all registered sources with their status and subscriber counts.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.listSources();
				const result = raw as { sources?: SourceInfo[]; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to list sources: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				const sources = result.sources ?? [];
				const lines = sources.map(
					(s) => `  ${s.name} [${s.status}] command="${s.command}" subscribers=${s.subscriberCount}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Sources:\n${lines.length > 0 ? lines.join("\n") : "  (none)"}\n\nUse subscribe_source to receive messages from a source.`,
						},
					],
					details: { sources },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to list sources: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
