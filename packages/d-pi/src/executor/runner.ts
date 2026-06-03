import type { ToolDefinition } from "@sheason/pi-coding-agent";

export type RunnerResult = { ok: true; result: unknown } | { ok: false; error: string };

export class ToolRunner {
	private readonly byName: Map<string, ToolDefinition>;
	constructor(tools: ToolDefinition[]) {
		this.byName = new Map(tools.map((t) => [t.name, t]));
	}
	async run(name: string, params: unknown): Promise<RunnerResult> {
		const tool = this.byName.get(name);
		if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
		try {
			const result = await (tool.execute as (a: unknown) => unknown)(params);
			return { ok: true, result };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
