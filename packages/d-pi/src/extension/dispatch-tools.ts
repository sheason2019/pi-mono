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
 * Map of native tool name → (tool definition factory, dispatch_* name).
 *
 * Each dispatch_* tool clones the native tool's `parameters` schema and
 * adds an optional `connect_id` parameter. When `connect_id` is omitted,
 * the tool runs locally on the hub host. When provided, it dispatches
 * to the connected client executor via the d-pi IPC channel.
 */
const TOOL_SPECS = [
	{ native: "bash", dispatch: "dispatch_bash", factory: createBashToolDefinition },
	{ native: "read", dispatch: "dispatch_read", factory: createReadToolDefinition },
	{ native: "ls", dispatch: "dispatch_ls", factory: createLsToolDefinition },
	{ native: "grep", dispatch: "dispatch_grep", factory: createGrepToolDefinition },
	{ native: "find", dispatch: "dispatch_find", factory: createFindToolDefinition },
	{ native: "write", dispatch: "dispatch_write", factory: createWriteToolDefinition },
	{ native: "edit", dispatch: "dispatch_edit", factory: createEditToolDefinition },
] as const;

/**
 * Register the 7 `dispatch_*` tools on a server agent's extension API.
 *
 * Each tool unifies local and remote execution:
 * - No `connect_id` parameter → runs locally on the hub host (same as
 *   the built-in pi-coding-agent tool).
 * - `connect_id` provided → dispatches to the specified d-pi client
 *   executor via the d-pi IPC channel.
 *
 * The built-in pi-coding-agent tools (bash, read, edit, ...) are
 * disabled via `excludeTools` in the agent-worker — agents only see
 * the `dispatch_*` family, so there is no ambiguity about which tool
 * to use for local vs remote operations.
 *
 * Dispatch path (remote): `HubChannel.callDispatch` →
 * `parentPort.postMessage` → `Hub._handleToolCall("dispatch", ...)` →
 * executor SSE → client runs the native tool → POST result back →
 * IPC resolve.
 *
 * Local path: calls the native `ToolDefinition.execute` directly in
 * the worker process (same code path as the built-in tool, just
 * invoked from the dispatch wrapper).
 */
export function createDispatchTools(channel: HubChannel, cwd: string): Array<ReturnType<typeof defineTool>> {
	// Build native tool definitions for local execution.
	// These carry the correct parameters schema + the execute implementation
	// for local runs. The cwd determines file path resolution for local ops.
	const nativeDefs: Record<string, unknown> = {};
	for (const spec of TOOL_SPECS) {
		nativeDefs[spec.native] = spec.factory(cwd);
	}

	const tools: Array<ReturnType<typeof defineTool>> = [];
	for (const spec of TOOL_SPECS) {
		const nativeDef = nativeDefs[spec.native] as {
			parameters: Record<string, unknown>;
			execute: (...a: unknown[]) => Promise<unknown>;
		};
		tools.push(
			defineTool({
				name: spec.dispatch,
				label: `Dispatch ${spec.native}`,
				description:
					`Execute ${spec.native} either locally on the hub host or remotely on a connected d-pi client. ` +
					"Without the `connect_id` parameter, runs on the hub host (same as a local tool). " +
					"With `connect_id`, dispatches to the specified connected client device. " +
					"Use `connect_id` when the task targets the user's device (their laptop, local files, shell environment). " +
					"Omit `connect_id` when operating on the hub host. " +
					"Do NOT use `connect_id` to test whether a client is connected — only use it when you need to operate on the user's device for a specific task.",
				parameters: {
					...(nativeDef.parameters as object),
					properties: {
						...((nativeDef.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
						connect_id: {
							type: "string",
							description:
								"Optional. The connect_id of the d-pi client to dispatch to. " +
								"Omit to run locally on the hub host. " +
								"Provide to run on the specified connected client device.",
						},
					},
				} as never,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const p = params as { connect_id?: string };
					const { connect_id, ...nativeParams } = p;

					if (!connect_id) {
						// Local execution: delegate to the native tool definition
						const result = await (nativeDef.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
							toolCallId,
							nativeParams,
							signal,
							onUpdate,
							ctx,
						);
						return result as never;
					}

					// Remote execution: dispatch via IPC to the specified connect_id
					const result = await channel.callDispatch(spec.native, nativeParams, connect_id);
					const r = result as { ok?: boolean; result?: unknown; error?: string };
					if (!r.ok) {
						throw new Error(r.error ?? "Unknown dispatch tool error");
					}
					// r.result is already a valid AgentToolResult (the native tool's
					// execute return value: { content, details }). Return it directly.
					return r.result as never;
				},
			}),
		);
	}
	return tools;
}
