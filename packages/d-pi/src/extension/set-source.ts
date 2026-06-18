import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createSetSourceTool(channel: HubChannel) {
	return defineTool({
		name: "set_source",
		label: "Set Source",
		description:
			"Create or update a long-running stdio source by name. The source name is its stable ID: calling set_source again with the same name updates that source instead of creating a duplicate. The command should be a persistent process that continuously produces JSON-RPC 2.0 notifications on stdout; one-shot commands that exit after producing output are not suitable. Subscribers are agent names and replace the source's subscriber list when provided.",
		parameters: Type.Object({
			name: Type.String({ description: "Stable source ID. This is also the source name." }),
			command: Type.String({
				description:
					'Program to run (argv[0]). Must be a long-running process that keeps producing output until deleted. The hub spawns the program with the `args` array as-is — no shell parsing, no globbing, no variable expansion. For shell features, invoke `sh` explicitly: `command: "sh"`, `args: ["-c", "tail -f /var/log/app.log | grep ERROR"]`.',
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: "Positional arguments passed verbatim to the program. Each element is one argv token.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the process" })),
			env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables" })),
			subscribers: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Agent names that should receive output from this source. When provided, this replaces the current subscribers list. When omitted for an existing source, current subscribers are preserved. When omitted for a new source, the calling agent is subscribed.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.setSource(params);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to set source: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Source "${params.name}" set.` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to set source: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
