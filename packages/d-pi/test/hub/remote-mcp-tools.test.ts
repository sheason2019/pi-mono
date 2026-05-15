import type { AgentToolResult } from "@sheason/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createRemoteMcpToolDefinitions,
	remoteMcpResourceToken,
	remoteMcpToolNameFromLocal,
} from "../../src/hub/mcp/remote-mcp-tools.js";
import type { McpRuntimeStatus } from "../../src/hub/mcp/types.js";
import type { PeerToolBridge } from "../../src/hub/tools/peer-tool-bridge.js";

const runningServer: McpRuntimeStatus = {
	resourceId: "filesystem-id",
	name: "filesystem",
	transport: "stdio",
	status: "running",
	capabilities: {
		tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
		resources: [],
		prompts: [],
	},
};

describe("remote MCP tools", () => {
	it("uses peer-scoped resource tokens and proxies execution to the owning peer", async () => {
		const executeTool = vi.fn(async (): Promise<AgentToolResult<unknown>> => {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		});
		const bridge = { executeTool } as unknown as PeerToolBridge;

		const tools = createRemoteMcpToolDefinitions({
			peerId: "work-laptop",
			servers: [runningServer],
			bridge,
		});

		const remoteToolName = `mcp__${remoteMcpResourceToken("work-laptop", "filesystem-id")}__read_file`;
		expect(tools.map((tool) => tool.name)).toEqual([remoteToolName]);
		expect(remoteToolName).not.toContain("peer_");
		await tools[0]!.execute("call-1", {}, undefined, undefined, {} as never);
		expect(executeTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: "call-1",
				toolName: remoteToolName,
				peerId: "work-laptop",
				args: {},
			}),
		);
	});

	it("uses a safe deterministic token for peer-scoped resource ids", () => {
		expect(remoteMcpResourceToken("ip/192.168.1.1:4317", "local fs")).toMatch(
			/^ip_192_168_1_1_4317_loca_[a-f0-9]{6}$/,
		);
	});

	it("maps local MCP tool names to peer-scoped remote tool names", () => {
		expect(remoteMcpToolNameFromLocal("work-laptop", "mcp__filesystem__read_file")).toBe(
			`mcp__${remoteMcpResourceToken("work-laptop", "filesystem")}__read_file`,
		);
		expect(remoteMcpToolNameFromLocal("work-laptop", "read")).toBeUndefined();
	});
});
