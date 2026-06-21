import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export type RunnerResult = { ok: true; result: unknown } | { ok: false; error: string };
export type DPiExecutableTool = AgentTool<TSchema, unknown>;

export class ToolRunner {
	private readonly byName: Map<string, DPiExecutableTool>;
	constructor(tools: DPiExecutableTool[]) {
		this.byName = new Map(tools.map((t) => [t.name, t]));
	}
	async run(callId: string, name: string, params: unknown): Promise<RunnerResult> {
		const tool = this.byName.get(name);
		if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
		try {
			const result = await tool.execute(callId, params, undefined, undefined);
			return { ok: true, result };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
