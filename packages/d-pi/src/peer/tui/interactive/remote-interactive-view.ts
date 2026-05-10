import type { HubAgentViewModel, HubWelcomePayload, RegisteredPeer } from "../../../hub/index.js";
import type { PeerLiveSnapshot } from "../../state/peer-app-state.js";
import type { PeerConnectionState } from "../../types.js";

export interface RemoteInteractiveCommandInfo {
	name: string;
	description: string;
}

export interface RemoteInteractiveConnectionView {
	state: PeerConnectionState;
	message?: string;
}

export interface RemoteInteractiveSessionView {
	header?: {
		type: "session";
		id: string;
		timestamp: string;
		version: number;
		cwd: string;
	};
	sessionId?: string;
	cwd?: string;
	protocolVersion?: number;
	sessionFile: string;
	items: HubAgentViewModel["items"];
	availableModels: HubAgentViewModel["availableModels"];
	availableThinkingLevels: HubAgentViewModel["availableThinkingLevels"];
	isRunning: boolean;
	pendingToolCallIds: string[];
	queuedMessages?: HubAgentViewModel["queue"]["messages"];
	model: HubAgentViewModel["context"]["model"];
	thinkingLevel: string;
	contextUsage?: HubAgentViewModel["context"]["contextUsage"];
	lastError?: string;
	diagnostics: string[];
	runStartedAt?: HubAgentViewModel["status"]["runStartedAt"];
	lastRunStartedAt?: HubAgentViewModel["status"]["lastRunStartedAt"];
	lastRunEndedAt?: HubAgentViewModel["status"]["lastRunEndedAt"];
	lastRunDurationMs?: HubAgentViewModel["status"]["lastRunDurationMs"];
	lastRunEndReason?: HubAgentViewModel["status"]["lastRunEndReason"];
}

export interface RemoteInteractiveFooterView {
	cwd: string;
	modelLabel: string;
	queueSummary: string;
	pendingToolCount: number;
	peerCount: number;
	isRunning: boolean;
	peerId: string;
	/** Hub agent this peer is bound to (from `hub:welcome` or hello until welcome arrives). */
	boundAgentId: string;
	sessionId?: string;
	contextWindow?: number;
	contextUsage?: HubAgentViewModel["context"]["contextUsage"];
}

export interface RemoteInteractiveStatusView {
	connectionMessage?: string;
	diagnostics: string[];
	lastError?: string;
	liveStatusMessage?: string;
	crdtResyncMessage?: string;
}

export interface RemoteInteractiveLiveView {
	streamingMessageId?: PeerLiveSnapshot["streamingMessageId"];
	streamingMessageIndex?: PeerLiveSnapshot["streamingMessageIndex"];
	streamingMessage?: PeerLiveSnapshot["streamingMessage"];
	toolExecutions: PeerLiveSnapshot["toolExecutions"];
	statusMessage?: PeerLiveSnapshot["statusMessage"];
}

export interface RemoteInteractiveGroupAgentView {
	id: string;
	isRunning: boolean;
	messageCount: number;
}

export interface RemoteInteractiveView {
	connection: RemoteInteractiveConnectionView;
	welcome?: HubWelcomePayload;
	session?: RemoteInteractiveSessionView;
	live?: RemoteInteractiveLiveView;
	agents?: RemoteInteractiveGroupAgentView[];
	peers: RegisteredPeer[];
	footer: RemoteInteractiveFooterView;
	status: RemoteInteractiveStatusView;
	commands: readonly RemoteInteractiveCommandInfo[];
}
