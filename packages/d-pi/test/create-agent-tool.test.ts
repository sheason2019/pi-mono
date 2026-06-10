import { describe, expect, it, vi } from "vitest";
import { createCreateAgentTool } from "../src/extension/create-agent.ts";
import type { HubChannel } from "../src/extension/hub-channel.ts";

/**
 * Tests for the create_agent extension tool.
 *
 * Focus: schema-level validation and mutex enforcement between
 * includeTools and excludeTools. The Hub-layer second-line defense
 * is exercised by integration paths; this file covers the user-facing
 * tool surface that the agent runtime invokes directly.
 */

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

function makeChannel(): HubChannel & { createAgent: ReturnType<typeof vi.fn> } {
	// The tool only calls channel.createAgent; we don't need the rest of
	// the HubChannel surface. Cast a bare object through unknown.
	const channel = {
		agentId: "test-agent",
		createAgent: vi.fn(),
	} as unknown as HubChannel & { createAgent: ReturnType<typeof vi.fn> };
	return channel;
}

function makeCtx(): Parameters<ToolExecute>[3] {
	return vi.fn();
}

describe("create_agent tool — includeTools / excludeTools", () => {
	it("rejects when both includeTools and excludeTools are provided (mutex)", async () => {
		const channel = makeChannel();
		const tool = createCreateAgentTool(channel);

		const params: ToolParams = {
			name: "child",
			includeTools: ["read"],
			excludeTools: ["bash"],
		};

		const result = await tool.execute("call-1", params, new AbortController().signal, makeCtx(), undefined as never);

		expect(isError(result)).toBe(true);
		expect(getText(result)).toMatch(/mutually exclusive/i);
		expect(getText(result)).toMatch(/includeTools/);
		expect(getText(result)).toMatch(/excludeTools/);
		expect(channel.createAgent).not.toHaveBeenCalled();
	});

	it("accepts includeTools only and forwards to channel", async () => {
		const channel = makeChannel();
		const okResult = {
			agentId: "abc-123",
			name: "child",
		};
		channel.createAgent.mockResolvedValueOnce(okResult);

		const tool = createCreateAgentTool(channel);
		const params: ToolParams = {
			name: "child",
			includeTools: ["bash"],
		};

		const result = await tool.execute("call-2", params, new AbortController().signal, makeCtx(), undefined as never);

		expect(isError(result)).toBe(false);
		expect(channel.createAgent).toHaveBeenCalledWith("child", undefined, undefined, undefined, ["bash"], undefined);
		expect(getText(result)).toMatch(/Created agent "child"/);
	});

	it("accepts excludeTools only and forwards to channel", async () => {
		const channel = makeChannel();
		const okResult = {
			agentId: "def-456",
			name: "child",
		};
		channel.createAgent.mockResolvedValueOnce(okResult);

		const tool = createCreateAgentTool(channel);
		const params: ToolParams = {
			name: "child",
			excludeTools: ["bash"],
		};

		const result = await tool.execute("call-3", params, new AbortController().signal, makeCtx(), undefined as never);

		expect(isError(result)).toBe(false);
		expect(channel.createAgent).toHaveBeenCalledWith("child", undefined, undefined, undefined, undefined, ["bash"]);
	});

	it("accepts neither (inherits all tools) and forwards undefined to channel", async () => {
		const channel = makeChannel();
		const okResult = {
			agentId: "ghi-789",
			name: "child",
		};
		channel.createAgent.mockResolvedValueOnce(okResult);

		const tool = createCreateAgentTool(channel);
		const params: ToolParams = {
			name: "child",
		};

		const result = await tool.execute("call-4", params, new AbortController().signal, makeCtx(), undefined as never);

		expect(isError(result)).toBe(false);
		expect(channel.createAgent).toHaveBeenCalledWith("child", undefined, undefined, undefined, undefined, undefined);
	});

	it("surfaces hub-side error result as isError", async () => {
		const channel = makeChannel();
		channel.createAgent.mockResolvedValueOnce({ error: "name conflict" });

		const tool = createCreateAgentTool(channel);
		const params: ToolParams = {
			name: "child",
		};

		const result = await tool.execute("call-5", params, new AbortController().signal, makeCtx(), undefined as never);

		expect(isError(result)).toBe(true);
		expect(getText(result)).toMatch(/name conflict/);
	});
});
