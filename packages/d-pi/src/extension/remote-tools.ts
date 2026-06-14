import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

/**
 * Native tool name → registered `remote_*` tool name mapping.
 *
 * Mirrors `agent-extension/remote-tools.ts`'s TOOL_NAME_MAP so the LLM
 * sees the same surface on the server agent as the (now-removed)
 * HTTP-fetch variant would have presented. The executor on the client
 * side only knows the native names (the tool factories in
 * `buildNativeToolSet` register `bash`, `read`, ...); the hub's
 * `_handleToolCall("remote", ...)` unwraps the `tool` field back to
 * the native name before dispatching.
 */
const TOOL_NAME_MAP = {
	bash: "remote_bash",
	read: "remote_read",
	ls: "remote_ls",
	grep: "remote_grep",
	find: "remote_find",
	write: "remote_write",
	edit: "remote_edit",
} as const;

/**
 * Register the 7 `remote_*` tools on a server agent's extension API.
 *
 * Unlike the (now-removed) `agent-extension/remote-tools.ts` variant,
 * which dispatched via HTTP fetch to `/agents/{name}/remote-call`, this
 * version dispatches through the d-pi IPC channel
 * (`HubChannel.callRemote` → `parentPort.postMessage` →
 * `Hub._handleToolCall("remote", ...)`). The IPC path needs no auth
 * token because the worker thread is spawned and trusted by the hub,
 * and it avoids the TCP loopback overhead of an HTTP round-trip back
 * to the hub's own gateway. The HTTP `/agents/{name}/remote-call`
 * endpoint remains available for non-worker callers (e.g. external
 * scripts), but server agents use this IPC path.
 *
 * Each tool's `execute` is a thin wrapper around `channel.callRemote`:
 * it forwards the native tool name and the caller's params verbatim to
 * the hub, which dispatches them to the bound client executor. The
 * LLM-facing description tells the model to use these tools when the
 * task targets the user's connected client machine.
 *
 * If no client is bound to this agent, `callRemote` rejects with a
 * clear error from the hub so the LLM can fall back to the local
 * built-in tool or ask the user to run `d-pi connect`.
 *
 * FIXME: parameter schemas (`parameters: {} as never`) — the LLM does
 * not see per-tool argument descriptions. The native schemas
 * (`bashSchema`, `readSchema`, ...) are not exported by
 * `@sheason/pi-coding-agent`, so we either need to re-declare them
 * here or have the upstream export them. Same FIXME as the old
 * `agent-extension/remote-tools.ts` carried.
 */
export function createRemoteTools(channel: HubChannel): Array<ReturnType<typeof defineTool>> {
	const tools: Array<ReturnType<typeof defineTool>> = [];
	for (const [nativeName, registeredName] of Object.entries(TOOL_NAME_MAP)) {
		tools.push(
			defineTool({
				name: registeredName,
				label: `Remote ${nativeName}`,
				description:
					`Run native ${nativeName} on the user's connected d-pi client. ` +
					"Same arguments as the built-in tool; the difference is the execution " +
					"location: the built-in tool runs on the hub host, the `remote_*` " +
					"variant runs on the d-pi client that is bound to this agent via " +
					"`d-pi connect`. Pick the one that matches the resource the task " +
					"targets — file paths and credentials on the user's laptop go " +
					`through \`remote_${nativeName}\`; paths on the hub host go through ` +
					`the built-in ${nativeName}. Requires a connected client; if no ` +
					"client is bound, the call returns an error explaining the situation.",
				parameters: Type.Object({}),
				async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
					const result = await channel.callRemote(nativeName, params);
					const r = result as { ok?: boolean; result?: unknown; error?: string };
					if (!r.ok) {
						throw new Error(r.error ?? "Unknown remote tool error");
					}
					return {
						content: [{ type: "text" as const, text: JSON.stringify(r.result) }],
						details: {},
					};
				},
			}),
		);
	}
	return tools;
}
