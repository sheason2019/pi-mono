import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
} from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

/**
 * Map of native tool name → (tool definition factory, registered `remote_*` name).
 *
 * We call each `create*ToolDefinition(cwd)` once to obtain the native
 * `ToolDefinition`, then extract its `parameters` schema for the
 * `remote_*` wrapper. The `execute` implementation of the native
 * definition is not used — we dispatch to the client executor instead.
 * The cwd argument only affects the native `execute` (file path
 * resolution), which we bypass, so a placeholder is fine.
 */
const TOOL_SPECS = [
	{ native: "bash", remote: "remote_bash", factory: createBashToolDefinition },
	{ native: "read", remote: "remote_read", factory: createReadToolDefinition },
	{ native: "ls", remote: "remote_ls", factory: createLsToolDefinition },
	{ native: "grep", remote: "remote_grep", factory: createGrepToolDefinition },
	{ native: "find", remote: "remote_find", factory: createFindToolDefinition },
	{ native: "write", remote: "remote_write", factory: createWriteToolDefinition },
	{ native: "edit", remote: "remote_edit", factory: createEditToolDefinition },
] as const;

/**
 * Register the 7 `remote_*` tools on a server agent's extension API.
 *
 * Each tool's `parameters` schema is **cloned from the native
 * pi-coding-agent tool definition** so the LLM sees exactly the same
 * argument schema as the built-in counterpart. The only difference
 * from the built-in tool is the name prefix (`remote_`) and the
 * `execute` implementation, which dispatches through the d-pi IPC
 * channel instead of running locally.
 *
 * Dispatch path: `HubChannel.callRemote` → `parentPort.postMessage`
 * → `Hub._handleToolCall("remote", ...)` → executor SSE → client
 * runs the native tool → POST result back → IPC resolve.
 *
 * No auth token is needed because the IPC channel is a trusted
 * parent-child relationship (the hub spawned the worker). The HTTP
 * `/agents/{name}/remote-call` endpoint remains available for
 * external callers, but server agents use this IPC path.
 *
 * If no client is bound to this agent, `callRemote` rejects with a
 * clear error from the hub.
 */
export function createRemoteTools(channel: HubChannel): Array<ReturnType<typeof defineTool>> {
	const tools: Array<ReturnType<typeof defineTool>> = [];
	for (const spec of TOOL_SPECS) {
		const nativeDef = spec.factory("/");
		tools.push(
			defineTool({
				name: spec.remote,
				label: `Remote ${spec.native}`,
				description:
					`Run native ${spec.native} on the user's connected d-pi client. ` +
					"Same arguments as the built-in tool; the difference is the execution " +
					"location: the built-in tool runs on the hub host, the `remote_*` " +
					"variant runs on the d-pi client that is bound to this agent via " +
					"`d-pi connect`. Pick the one that matches the resource the task " +
					"targets — file paths and credentials on the user's laptop go " +
					`through \`${spec.remote}\`; paths on the hub host go through ` +
					`the built-in ${spec.native}. Requires a connected client; if no ` +
					"client is bound, the call returns an error explaining the situation.",
				parameters: nativeDef.parameters,
				async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
					const result = await channel.callRemote(spec.native, params);
					const r = result as { ok?: boolean; result?: unknown; error?: string };
					if (!r.ok) {
						throw new Error(r.error ?? "Unknown remote tool error");
					}
					// r.result is already a valid AgentToolResult (the native tool's
					// execute return value: { content, details }). Return it
					// directly — do NOT JSON.stringify it into a new text block
					// (that would create double-nested JSON the LLM can't parse).
					return r.result as never;
				},
			}),
		);
	}
	return tools;
}
