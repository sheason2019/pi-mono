import { describe, expect, it, vi } from "vitest";
import { setBuiltinContext } from "../src/surface/builtin-context.ts";
import type { DPiHubActionsClient } from "../src/surface/index.ts";
import { createCreateAgentTool } from "../src/surface/orchestration-tools.ts";

type ToolExecute = ReturnType<typeof createCreateAgentTool>["execute"];
type ToolParams = Parameters<ToolExecute>[1];
type ToolResult = Awaited<ReturnType<ToolExecute>>;

function isError(result: ToolResult): boolean {
	return Boolean((result as { isError?: boolean }).isError);
}

function getText(result: ToolResult): string {
	const content = (result as { content: Array<{ type: string; text: string }> }).content;
	return content[0]?.text ?? "";
}

function makeClient(): DPiHubActionsClient & { createAgent: ReturnType<typeof vi.fn> } {
	const client = {
		createAgent: vi.fn(),
	} as unknown as DPiHubActionsClient & { createAgent: ReturnType<typeof vi.fn> };
	return client;
}

function setupContext(client: DPiHubActionsClient): void {
	setBuiltinContext({
		hubClient: client,
		agentName: "root",
		localExecutors: {},
		remoteExecutor: {
			async executeRemoteTool(): Promise<never> {
				throw new Error("not implemented");
			},
		},
		getReloadFn: () => undefined,
		getReloadDetails: () => ({}),
		updatePlan: () => {},
		getPlan: () => [],
	});
}

describe("create_agent tool", () => {
	it("forwards only skeleton creation fields to the hub", async () => {
		const client = makeClient();
		const okResult = {
			agentId: "abc-123",
			agentName: "child",
		};
		client.createAgent.mockResolvedValueOnce(okResult);
		setupContext(client);

		const tool = createCreateAgentTool();
		const params: ToolParams = {
			name: "child",
			cwd: "/repo/agents/child",
		};

		const result = await tool.execute("call-2", params, new AbortController().signal);

		expect(isError(result)).toBe(false);
		expect(client.createAgent).toHaveBeenCalledWith({ name: "child", cwd: "/repo/agents/child" });
		expect(getText(result)).toMatch(/Created agent "child"/);
	});

	it("surfaces hub-side error result as isError", async () => {
		const client = makeClient();
		client.createAgent.mockRejectedValueOnce(new Error("name conflict"));
		setupContext(client);

		const tool = createCreateAgentTool();
		const params: ToolParams = {
			name: "child",
		};

		const result = await tool.execute("call-5", params, new AbortController().signal);

		expect(isError(result)).toBe(true);
		expect(getText(result)).toMatch(/name conflict/);
	});
});
