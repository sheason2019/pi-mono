import type { ToolDefinition } from "@sheason/pi-coding-agent";
import type { PeerRegistry } from "../peers/peer-registry.js";
import { createPeerMcpRouterToolDefinition } from "./peer-mcp-router.js";
import type { PeerToolBridge } from "./peer-tool-bridge.js";
import { createPeerToolDefinitions } from "./peer-tools.js";

export interface CreateHubToolsOptions {
	cwd: string;
	/** Reserved for per-agent tool naming and routing. */
	agentId: string;
	peerRegistry: PeerRegistry;
	peerToolBridge: PeerToolBridge;
	/** Tools merged from shared hub resources (e.g. MCP) when wiring multi-agent runtimes. */
	sharedTools?: ToolDefinition[];
	/** Additional tools scoped to a single agent. */
	agentTools?: ToolDefinition[];
	allowHostExecutor?: boolean | (() => boolean);
	includePeerTools?: boolean;
}

export function createHubTools(options: CreateHubToolsOptions): ToolDefinition[] {
	const { cwd, peerToolBridge, sharedTools, agentTools, allowHostExecutor } = options;
	const peerTools =
		options.includePeerTools === false
			? []
			: [
					...createPeerToolDefinitions(cwd, peerToolBridge, { allowHostExecutor }),
					createPeerMcpRouterToolDefinition(peerToolBridge),
				];
	return [...peerTools, ...(sharedTools ?? []), ...(agentTools ?? [])];
}
