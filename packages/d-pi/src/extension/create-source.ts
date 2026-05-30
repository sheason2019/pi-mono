import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createCreateSourceTool(channel: HubChannel) {
	return defineTool({
		name: "create_source",
		label: "Create Source",
		description:
			"Register a new stdio source with the hub. The hub will spawn a child process and read its stdout/stderr line by line. Agents can subscribe to receive the output.",
		parameters: Type.Object({
			name: Type.String({ description: "Unique name for the source" }),
			command: Type.String({ description: "Command to spawn (e.g. 'tail -f build.log')" }),
			args: Type.Optional(Type.Array(Type.String(), { description: "Arguments to the command" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the process" })),
			env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.createSource(params.name, params.command, params.args, params.cwd, params.env);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to create source: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Source "${params.name}" created and running. You have been automatically subscribed to this source.`,
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to create source: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
