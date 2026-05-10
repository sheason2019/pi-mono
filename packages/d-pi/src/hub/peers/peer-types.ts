import type { PeerConfigSnapshot } from "../config-aggregation/types.js";
import type { McpRuntimeStatus } from "../mcp/types.js";

export interface PeerMcpSnapshot {
	servers: McpRuntimeStatus[];
	configError?: string;
}

export interface PeerConfigPayload {
	tools?: string[];
	configSnapshot?: PeerConfigSnapshot;
	mcpSnapshot?: PeerMcpSnapshot;
}

export interface PeerHelloPayload {
	peerId: string;
	/**
	 * Target hub agent. If omitted, the peer binds to the default agent (typically `root`).
	 */
	agentId?: string;
	/** Access token required by the hub. */
	token: string;
	/**
	 * `peer` clients can execute peer tools and are listed in peer/executor registries.
	 * `host` clients are remote hub UIs only; they may drive the hub session but are not executors.
	 */
	clientKind?: "peer" | "host";
	protocolVersion: number;
	displayName?: string;
	version?: string;
	platform?: string;
	hostname?: string;
	cwd?: string;
	executorEnabled?: boolean;
}

export interface RegisteredPeer {
	agentId: string;
	peerId: string;
	socketId: string;
	protocolVersion: number;
	displayName?: string;
	version?: string;
	platform?: string;
	hostname?: string;
	cwd?: string;
	executorEnabled: boolean;
	tools: string[];
	mcpSnapshot?: PeerMcpSnapshot;
	connectedAt: string;
	transport: "socket.io";
}

export interface RegisterPeerResult {
	peer: RegisteredPeer;
	replacedSocketId?: string;
}

export interface UpdatePeerConfigResult {
	peer: RegisteredPeer;
}

export type PeerRegistryEvent =
	| {
			type: "registered";
			peer: RegisteredPeer;
			replacedSocketId?: string;
	  }
	| {
			type: "updated";
			peer: RegisteredPeer;
	  }
	| {
			type: "unregistered";
			peer: RegisteredPeer;
	  };
