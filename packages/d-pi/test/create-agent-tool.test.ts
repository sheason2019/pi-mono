import { describe, expect, it, vi } from "vitest";
import type { DPiHubActionsClient } from "../src/surface/index.ts";
import { createDPiCreateAgentTool } from "../src/surface/orchestration-tools.ts";

/**
 * Tests for the create_agent extension tool.
 *
 * Focus: schema-level validation and mutex enforcement between
 * includeTools and excludeTools. The Hub-layer second-line defense
 * is exercised by integration paths; this file covers the user-facing
 * tool surface that the agent runtime invokes directly.
 */

type ToolExecute = ReturnType<typeof createDPiCreateAgentTool>["execute"];
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

function makeCtx(): Parameters<ToolExecute>[3] {
	return vi.fn();
}

describe("create_agent tool — includeTools / excludeTools", () => {
	it("rejects when both includeTools and excludeTools are provided (mutex)", async () => {
		const client = makeClient();
		const tool = createDPiCreateAgentTool(client);

		const params: ToolParams = {
			name: "child",
			includeTools: ["read"],
			excludeTools: ["bash"],
		};

		const result = await tool.execute("call-1", params, new AbortController().signal, makeCtx());

		expect(isError(result)).toBe(true);
		expect(getText(result)).toMatch(/mutually exclusive/i);
		expect(getText(result)).toMatch(/includeTools/);
		expect(getText(result)).toMatch(/excludeTools/);
		expect(client.createAgent).not.toHaveBeenCalled();
	});

	it("accepts includeTools only and forwards to channel", async () => {
		const client = makeClient();
		const okResult = {
			agentId: "abc-123",
			agentName: "child",
		};
		client.createAgent.mockResolvedValueOnce(okResult);

		const tool = createDPiCreateAgentTool(client);
		const params: ToolParams = {
			name: "child",
			includeTools: ["bash"],
		};

		const result = await tool.execute("call-2", params, new AbortController().signal, makeCtx());

		expect(isError(result)).toBe(false);
		expect(client.createAgent).toHaveBeenCalledWith({ name: "child", includeTools: ["bash"] });
		expect(getText(result)).toMatch(/Created agent "child"/);
	});

	it("accepts excludeTools only and forwards to channel", async () => {
		const client = makeClient();
		const okResult = {
			agentId: "def-456",
			agentName: "child",
		};
		client.createAgent.mockResolvedValueOnce(okResult);

		const tool = createDPiCreateAgentTool(client);
		const params: ToolParams = {
			name: "child",
			excludeTools: ["bash"],
		};

		const result = await tool.execute("call-3", params, new AbortController().signal, makeCtx());

		expect(isError(result)).toBe(false);
		expect(client.createAgent).toHaveBeenCalledWith({ name: "child", excludeTools: ["bash"] });
	});

	it("accepts neither (inherits all tools) and forwards undefined to channel", async () => {
		const client = makeClient();
		const okResult = {
			agentId: "ghi-789",
			agentName: "child",
		};
		client.createAgent.mockResolvedValueOnce(okResult);

		const tool = createDPiCreateAgentTool(client);
		const params: ToolParams = {
			name: "child",
		};

		const result = await tool.execute("call-4", params, new AbortController().signal, makeCtx());

		expect(isError(result)).toBe(false);
		expect(client.createAgent).toHaveBeenCalledWith({ name: "child" });
	});

	it("surfaces hub-side error result as isError", async () => {
		const client = makeClient();
		client.createAgent.mockRejectedValueOnce(new Error("name conflict"));

		const tool = createDPiCreateAgentTool(client);
		const params: ToolParams = {
			name: "child",
		};

		const result = await tool.execute("call-5", params, new AbortController().signal, makeCtx());

		expect(isError(result)).toBe(true);
		expect(getText(result)).toMatch(/name conflict/);
	});
});
