export type PeerConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export type PeerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PeerConnectionStatus {
	state: PeerConnectionState;
	message?: string;
}
