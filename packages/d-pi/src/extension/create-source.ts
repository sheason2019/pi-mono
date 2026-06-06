import { Type } from "@sheason/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
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
					'Program to run (argv[0]). Must be a long-running process that keeps producing output until destroyed. The hub spawns the program with the `args` array as-is — no shell parsing, no globbing, no variable expansion. For shell features (pipes, redirects, globs), invoke `sh` explicitly: `command: "sh"`, `args: ["-c", "tail -f /var/log/app.log | grep ERROR"]`.',
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Positional arguments passed verbatim to the program. Each element is one argv token — no shell tokenisation, no quote stripping. To pass a single argument containing spaces, make it one element of this array; do not split it across multiple elements or try to quote it with `"` or `\'`. Example: `args: ["-c", "echo hello world"]` runs `sh -c \'echo hello world\'`.',
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
