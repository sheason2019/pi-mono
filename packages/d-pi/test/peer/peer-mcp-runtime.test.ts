import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { PeerMcpRuntime, type PeerMcpRuntimeHost } from "../../src/peer/mcp/peer-mcp-runtime.js";

function createTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined })),
	};
}

describe("PeerMcpRuntime", () => {
	it("exposes peer-scoped MCP tool names and executes the local MCP tool", async () => {
		const tool = createTool("mcp__filesystem-id__read_file");
		const host: PeerMcpRuntimeHost = {
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			getStatuses: () => [
				{
					resourceId: "filesystem-id",
					name: "filesystem",
					transport: "stdio",
					status: "running",
					capabilities: {
						tools: [{ name: "read_file", inputSchema: { type: "object", properties: {} } }],
						resources: [],
						prompts: [],
					},
				},
			],
			getConfigError: () => undefined,
			getSharedCustomToolsArray: () => [tool],
		};
		const runtime = new PeerMcpRuntime({
			cwd: "/tmp",
			snapshot: { version: 1, capturedAt: "now", cwd: "/tmp" },
			host,
		});
		const emit = vi.fn();

		const [remoteToolName] = runtime.getRemoteToolNames("peer-a");
		expect(remoteToolName).toBeDefined();
		expect(remoteToolName).not.toContain("peer_");
		await runtime.executeToolRequest(
			"peer-a",
			{
				toolCallId: "call-1",
				toolName: remoteToolName!,
				args: {},
				timeoutMs: 1000,
			},
			{ emit },
		);

		expect(emit).toHaveBeenCalledWith("tool:call_ack", { toolCallId: "call-1" });
		expect(emit).toHaveBeenCalledWith("tool:call_result", {
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
		});
		expect(tool.execute).toHaveBeenCalled();
	});
});
