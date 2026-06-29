import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export type ToolCallResult =
	| { ok: true; result: AgentToolResult<unknown> }
	| { ok: false; result: null; error: string };

export class ToolRunner {
	private readonly _tools: AgentTool[];
	private readonly _abortControllers = new Map<string, AbortController>();

	constructor(tools: AgentTool[]) {
		this._tools = tools;
	}

	cancelCall(callId: string): void {
		const ac = this._abortControllers.get(callId);
		if (ac) {
			ac.abort();
		}
	}

	async run(callId: string, name: string, params: Record<string, unknown>): Promise<ToolCallResult> {
		const tool = this._tools.find((t) => t.name === name);

		if (!tool) {
			return { ok: false, result: null, error: `unknown tool: ${name}` };
		}

		const ac = new AbortController();
		this._abortControllers.set(callId, ac);

		try {
			const result = await tool.execute(callId, params as never, ac.signal, undefined);
			this._abortControllers.delete(callId);
			return { ok: true, result };
		} catch (err) {
			this._abortControllers.delete(callId);
			const error = err as Error;
			if (error.name === "AbortError") {
				return { ok: false, result: null, error: "aborted" };
			}
			return { ok: false, result: null, error: error.message };
		}
	}
}
