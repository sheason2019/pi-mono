import { describe, expect, it, vi } from "vitest";
import { createPeerMcpRouterToolDefinition } from "../../src/hub/tools/peer-mcp-router.js";
import type { PeerToolBridge } from "../../src/hub/tools/peer-tool-bridge.js";

describe("peer_mcp router tool", () => {
	it("routes exact peer MCP tool names through PeerToolBridge", async () => {
		const executeTool = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "ok" }],
			details: { ok: true },
		}));
		const tool = createPeerMcpRouterToolDefinition({ executeTool } as unknown as PeerToolBridge);

		const result = await tool.execute(
			"call-1",
			{
				"peer-id": "peer-a",
				"tool-name": "mcp__peer_a_fs__read_file",
				args: { path: "README.md" },
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(executeTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: "call-1",
				peerId: "peer-a",
				toolName: "mcp__peer_a_fs__read_file",
				args: { path: "README.md" },
			}),
		);
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	});
});
