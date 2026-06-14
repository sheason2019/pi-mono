import type { ToolDefinition } from "@sheason/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	SettingsManager,
} from "@sheason/pi-coding-agent";
import { ExecutorClient } from "./client.ts";
import { type ExecutorEnv, readExecutorEnv } from "./env.ts";
import { ToolRunner } from "./runner.ts";

export { readExecutorEnv, type ExecutorEnv, ExecutorClient, ToolRunner };

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

/** Build the canonical native tool set, one per supported tool name.
 *  Each tool is constructed with the executor's cwd so file-system
 *  operations resolve relative paths the same way the agent worker's
 *  tools do. The bash tool picks up `shellPath` and `commandPrefix`
 *  from `~/.pi/agent/settings.json` via SettingsManager — same path
 *  the server-side AgentSession uses — so a user who configures
 *  `shellPath` on a non-standard bash location (scoop, cygwin, etc.)
 *  gets consistent behavior on both ends. */
export function buildNativeToolSet(cwd: string): Array<ToolDefinition> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const shellPath = settingsManager.getShellPath();
	const commandPrefix = settingsManager.getShellCommandPrefix();

	const tools = [
		createBashToolDefinition(cwd, { shellPath, commandPrefix }),
		createEditToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createLsToolDefinition(cwd),
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
	return tools as unknown as Array<ToolDefinition>;
}

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
