import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PeerToolBridge } from "./peer-tool-bridge.js";

export const PEER_MCP_ROUTER_TOOL_NAME = "peer_mcp";

export function createPeerMcpRouterToolDefinition(bridge: PeerToolBridge): ToolDefinition {
	return defineTool({
		name: PEER_MCP_ROUTER_TOOL_NAME,
		label: "Peer MCP",
		description:
			"Execute a peer-provided MCP tool by exact tool name. Use the d-pi-peer-resources skill to discover peer MCP capabilities first.",
		parameters: Type.Object({
			"peer-id": Type.String({ minLength: 1, description: "Connected peer id that provides the MCP tool." }),
			"tool-name": Type.String({ minLength: 1, description: "Exact peer MCP tool name, usually mcp__...__..." }),
			args: Type.Optional(
				Type.Record(Type.String(), Type.Any(), { description: "Arguments for the peer MCP tool." }),
			),
		}),
		promptGuidelines: [
			"Use peer_mcp only after reading d-pi-peer-resources or otherwise knowing the exact peer MCP tool name.",
			"Pass peer-id and tool-name exactly as listed by the D-Pi peer resource index.",
		],
		async execute(toolCallId, params, signal, onUpdate) {
			const input = params as { "peer-id": string; "tool-name": string; args?: Record<string, unknown> };
			return bridge.executeTool({
				toolCallId,
				toolName: input["tool-name"],
				peerId: input["peer-id"],
				args: input.args ?? {},
				signal,
				onUpdate,
			});
		},
	});
}
