import type { ToolDefinition } from "@sheason/pi-coding-agent";

export interface RemoteToolsContext {
	api: { DPI_HUB_URL: string; DPI_AUTH_TOKEN: string; agentId: string };
	fetchImpl: typeof fetch;
	registerTool: (name: string, def: ToolDefinition) => void;
}

const TOOL_NAME_MAP = {
	bash: "remote_bash",
	read: "remote_read",
	ls: "remote_ls",
	grep: "remote_grep",
	find: "remote_find",
	write: "remote_write",
	edit: "remote_edit",
} as const;

export function createRemoteToolsExtension(ctx: RemoteToolsContext): void {
	for (const [native, remote] of Object.entries(TOOL_NAME_MAP)) {
		ctx.registerTool(remote, makeRemoteTool(native, remote, ctx));
	}
}

function makeRemoteTool(nativeName: string, registeredName: string, ctx: RemoteToolsContext): ToolDefinition {
	return {
		name: registeredName,
		label: "Remote " + nativeName,
		description:
			"Run native " +
			nativeName +
			" on the connected client. The arguments are passed through verbatim to the client-side executor.",
		parameters: {} as never,
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_extCtx: unknown,
		): Promise<unknown> => {
			const callId = crypto.randomUUID();
			const url = ctx.api.DPI_HUB_URL + "/agents/" + ctx.api.agentId + "/remote-call";
			const headers: Record<string, string> = {
				Authorization: "Bearer " + ctx.api.DPI_AUTH_TOKEN,
				"Content-Type": "application/json",
			};
			let res: Response;
			try {
				// I7: forward the upstream AbortSignal so Ctrl+C / cancellation
				// from the agent propagates to the hub request and the
				// executor's running tool.
				res = await ctx.fetchImpl(url, {
					method: "POST",
					headers,
					body: JSON.stringify({ callId, tool: nativeName, params }),
					signal,
				});
			} catch (e) {
				throw new Error("Hub unreachable: " + (e instanceof Error ? e.message : String(e)));
			}
			if (!res.ok) {
				throw new Error("Hub returned " + res.status + ": " + (await res.text()));
			}
			const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
			if (!body.ok) {
				throw new Error(body.error ?? "Unknown hub error");
			}
			return body.result;
		},
		// FIXME: the upstream ToolDefinition requires strongly-typed parameter
		// schemas (TParams). We pass through params verbatim and rely on the
		// remote executor's tool factories to enforce shape. Tighten to the
		// canonical native tool schemas in a follow-up so the LLM sees correct
		// parameter descriptions.
	} as unknown as ToolDefinition;
}
