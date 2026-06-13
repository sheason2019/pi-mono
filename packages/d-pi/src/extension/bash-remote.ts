import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

/**
 * `bash_remote` — Execute a bash command on a connected d-pi client.
 *
 * Companion to the built-in `bash` tool. Identical parameters;
 * different execution location. This tool dispatches the command
 * via d-pi's executor registry to the SSE-connected client that
 * has bound this agent. The client runs the command locally and
 * returns the result.
 *
 * Routing contract (server → client):
 *   1. Server-side `bashRemote.execute()` calls
 *      `channel.callTool("call_executor", { tool: "bash", params: {...} })`.
 *   2. Hub `_handleToolCall("call_executor", ...)` looks up
 *      `agentBindings[agentName]`, throws if the agent is not bound to
 *      a client (no executor connected), and then calls
 *      `executorRegistry.dispatch(...)` which pushes a
 *      `remote-call` event to the client's SSE channel.
 *   3. Client `ToolRunner.run(callId, "bash", params)` invokes the
 *      built-in `bash` tool on the client side, which spawns the
 *      command locally and returns the result.
 *   4. Client POSTs the result to `/_hub/executor/results`, the hub
 *      resolves the pending call, and the original IPC `tool_result`
 *      flows back to the worker thread, completing the
 *      `bashRemote.execute()` promise.
 *
 * The tool is intentionally name-spaced (`bash_remote`, not `bash`)
 * so that it can coexist with the built-in `bash` tool in the
 * AgentSession's tool registry. The system prompt describes when
 * to pick one over the other; this file intentionally does not
 * express a preference.
 */
export function createBashRemoteTool(channel: HubChannel) {
	return defineTool({
		name: "bash_remote",
		label: "Bash (Remote / Connected Client)",
		description:
			"Execute a bash command on the user's connected d-pi client. Same parameters as the built-in `bash` tool; the difference is the execution location: `bash` runs in this worker thread, `bash_remote` runs on the d-pi client that is bound to this agent via `d-pi connect`. Pick the one that matches the resource the task targets — file paths and credentials on the user's laptop go through `bash_remote`; paths and credentials on the d-pi hub host go through `bash`. If no client is bound to this agent the call fails with an explanatory error.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute on the connected client" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await channel.callExecutor("bash", {
					command: params.command,
					timeout: params.timeout,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `bash_remote failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}
		},
	});
}
