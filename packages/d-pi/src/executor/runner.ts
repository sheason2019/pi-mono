import type { ToolDefinition } from "@sheason/pi-coding-agent";

export type RunnerResult = { ok: true; result: unknown } | { ok: false; error: string };

export class ToolRunner {
	private readonly byName: Map<string, ToolDefinition>;
	constructor(tools: ToolDefinition[]) {
		this.byName = new Map(tools.map((t) => [t.name, t]));
	}
	async run(callId: string, name: string, params: unknown): Promise<RunnerResult> {
		const tool = this.byName.get(name);
		if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
		try {
			// pi-coding-agent ToolDefinition.execute is 5-arg:
			//   (toolCallId, params, signal, onUpdate, ctx).
			// The executor runs without a parent AgentToolUpdate callback and
			// without a parent ExtensionContext, so signal / onUpdate / ctx
			// are undefined here. This matches the connect-mode path used by
			// the agent-side remote-tools wrapper.
			const result = await (
				tool.execute as unknown as (id: string, p: unknown, signal: undefined, onUpdate: undefined) => unknown
			)(callId, params, undefined, undefined);
			return { ok: true, result };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
