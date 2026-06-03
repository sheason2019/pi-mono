import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { ExecutorClient } from "./client.ts";
import { type ExecutorEnv, readExecutorEnv } from "./env.ts";
import { ToolRunner } from "./runner.ts";

export { readExecutorEnv, type ExecutorEnv, ExecutorClient, ToolRunner };

/** Entry point for the executor subprocess. Reads env, chdirs, opens
 *  the hub client, and runs until the hub disconnects.
 *
 *  The tool set is built lazily from the native tools' registrations.
 *  In a real deployment the executor would receive the list of available
 *  tools from the hub; for v1 we register the canonical native set
 *  (read, ls, grep, find, bash, write, edit) by name. Wiring those into
 *  ToolDefinition instances is deferred to the inline-extension work. */
export async function main(): Promise<void> {
	const env = readExecutorEnv();
	process.chdir(env.cwd);
	const tools: ToolDefinition[] = []; // populated by the inline-extension consumer
	const runner = new ToolRunner(tools);
	const client = new ExecutorClient({
		hubUrl: env.hubUrl,
		authToken: env.authToken,
		connectId: env.connectId,
		onCommand: async (event) => {
			const result = await runner.run(event.tool, event.params);
			await client.sendResult({
				callId: event.callId,
				...result,
			});
		},
	});
	await client.start();
	process.stderr.write("[executor] connected to " + env.hubUrl + " as " + env.connectId + " (cwd=" + env.cwd + ")\n");
}
