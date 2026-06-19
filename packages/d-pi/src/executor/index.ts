import { ExecutorClient } from "./client.ts";
import { buildNativeToolSet } from "./coding-agent-native-tools.ts";
import { type ExecutorEnv, readExecutorEnv } from "./env.ts";
import { ToolRunner } from "./runner.ts";

export { buildNativeToolSet, readExecutorEnv, type ExecutorEnv, ExecutorClient, ToolRunner };

// Install SIGTERM/SIGINT handlers at module load so the executor exits
// promptly when d-pi connect signals it. The executor's only long-lived
// I/O is the SSE stream to the hub, and Node's default signal behavior
// waits for that to drain — which never happens — so we have to short-
// circuit it. The handlers are installed here, not in cli.ts, because
// the connect parent actually spawns `d-pi _executor-child`, which
// dispatches to main() via cli-runner without ever loading cli.ts.
const exitOnSignal = (signal: NodeJS.Signals): void => {
	process.stderr.write(`[d-pi executor] received ${signal}, exiting\n`);
	process.exit(0);
};
process.on("SIGTERM", exitOnSignal);
process.on("SIGINT", exitOnSignal);

/** Entry point for the executor subprocess. Reads env, chdirs, builds the
 *  canonical native tool set (matching what the agent worker uses), opens
 *  the hub client, and runs until the hub disconnects. */
export async function main(): Promise<void> {
	const env = readExecutorEnv();
	process.chdir(env.cwd);
	const runner = new ToolRunner(buildNativeToolSet(env.cwd));
	const client = new ExecutorClient({
		hubUrl: env.hubUrl,
		authToken: env.authToken,
		connectId: env.connectId,
		onCommand: async (event) => {
			const result = await runner.run(event.callId, event.tool, event.params);
			await client.sendResult({
				callId: event.callId,
				...result,
			});
		},
	});
	await client.start();
	process.stderr.write(`[executor] connected to ${env.hubUrl} as ${env.connectId} (cwd=${env.cwd})\n`);
}
