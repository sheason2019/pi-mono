import type { AgentToolDefinition } from "../agent-definition.ts";

export type RunnerResult = { ok: true; result: unknown } | { ok: false; error: string };
export type DPiExecutableTool = AgentToolDefinition;

export class ToolRunner {
	private readonly byName: Map<string, DPiExecutableTool>;
	constructor(tools: DPiExecutableTool[]) {
		this.byName = new Map(tools.map((t) => [t.name, t]));
	}
	async run(callId: string, name: string, params: unknown): Promise<RunnerResult> {
		const tool = this.byName.get(name);
		if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
		try {
			const result = await tool.execute(callId, params as never, undefined, undefined);
			return { ok: true, result };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
