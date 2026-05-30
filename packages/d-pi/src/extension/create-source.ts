import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createCreateSourceTool(channel: HubChannel) {
	return defineTool({
		name: "create_source",
		label: "Create Source",
		description:
			"Register a new long-running stdio source with the hub. The command should be a persistent process that continuously produces output (e.g. 'tail -f /var/log/syslog', 'kubectl logs -f deploy/app'). One-shot commands that exit after producing output are NOT suitable — a source is meant to stream output over time, not run a batch job. If the process exits with a non-zero code, it is restarted with exponential backoff. If it exits normally (code 0), no restart is scheduled.",
		parameters: Type.Object({
			name: Type.String({ description: "Unique name for the source" }),
			command: Type.String({
				description:
					"Shell command to run. Must be a long-running process. For complex commands with pipes, loops, or variables, put the entire command here as a single string.",
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Simple positional arguments appended to the command. Only use for plain tokens like filenames or flags. Do NOT use for shell syntax (quotes, variables, pipes, loops) — put those in the command field instead.",
				}),
			),
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
