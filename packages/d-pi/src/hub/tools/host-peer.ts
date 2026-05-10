import { hostname, platform } from "node:os";
import type { RegisteredPeer } from "../peers/peer-types.js";
import { HUB_PROTOCOL_VERSION } from "../transport/protocol.js";

export const HOST_PEER_ID = "host";

export const HOST_PEER_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;

export interface HostPeerRecord extends Omit<RegisteredPeer, "socketId" | "transport" | "tools"> {
	socketId?: never;
	transport: "host";
	tools: string[];
}

export type ToolExecutorPeer = RegisteredPeer | HostPeerRecord;

export function createHostPeerRecord(agentId: string, cwd: string): HostPeerRecord {
	return {
		agentId,
		peerId: HOST_PEER_ID,
		protocolVersion: HUB_PROTOCOL_VERSION,
		displayName: "pi-hub host",
		platform: platform(),
		hostname: hostname(),
		cwd,
		executorEnabled: true,
		tools: [...HOST_PEER_TOOL_NAMES],
		connectedAt: new Date(0).toISOString(),
		transport: "host",
	};
}
