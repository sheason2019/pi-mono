import type {
	DPiAgentMessage,
	DPiCustomMessage,
	DPiJsonValue,
	DPiRuntimeError,
	DPiRuntimeQueues,
	DPiRuntimeSessionInfo,
	DPiRuntimeSnapshot,
	DPiRuntimeStatePatch,
	DPiToolStatus,
} from "./types.ts";

export interface DPiAgentRunStartEvent {
	type: "agent_start";
	agentName: string;
}

export interface DPiAgentRunEndEvent {
	type: "agent_end";
	agentName: string;
}

export interface DPiAssistantStreamEvent {
	type: "assistant_stream";
	agentName: string;
	message?: DPiAgentMessage;
	delta?: string;
	done: boolean;
}

export interface DPiCustomMessageEvent {
	type: "d_pi_message";
	agentName: string;
	message: DPiCustomMessage;
}

export interface DPiToolStartEvent {
	type: "tool_start";
	agentName: string;
	tool: {
		id: string;
		name: string;
		args?: DPiJsonValue;
		startedAt: number;
	};
}

export interface DPiToolUpdateEvent {
	type: "tool_update";
	agentName: string;
	toolCallId: string;
	status: DPiToolStatus;
	message?: string;
	details?: DPiJsonValue;
}

export interface DPiToolEndEvent {
	type: "tool_end";
	agentName: string;
	toolCallId: string;
	status: Extract<DPiToolStatus, "succeeded" | "failed" | "cancelled">;
	result?: DPiJsonValue;
	error?: string;
	endedAt: number;
}

export interface DPiQueueUpdateEvent {
	type: "queue_update";
	agentName: string;
	queues: DPiRuntimeQueues;
}

export interface DPiSessionReplacementEvent {
	type: "session_replaced";
	agentName: string;
	previousSessionId?: string;
	session: DPiRuntimeSessionInfo;
	messages: DPiAgentMessage[];
}

export interface DPiStateUpdateEvent {
	type: "state_update";
	agentName: string;
	state: DPiRuntimeStatePatch;
}

export interface DPiSnapshotUpdateEvent {
	type: "snapshot_update";
	snapshot: DPiRuntimeSnapshot;
}

export interface DPiTurnStatsEvent {
	type: "turn_stats";
	agentName: string;
	tps: number;
	output: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	duration: number;
}

export interface DPiErrorEvent {
	type: "error";
	agentName?: string;
	error: DPiRuntimeError;
}

export type DPiRuntimeEvent =
	| DPiAgentRunStartEvent
	| DPiAgentRunEndEvent
	| DPiAssistantStreamEvent
	| DPiCustomMessageEvent
	| DPiToolStartEvent
	| DPiToolUpdateEvent
	| DPiToolEndEvent
	| DPiQueueUpdateEvent
	| DPiSessionReplacementEvent
	| DPiStateUpdateEvent
	| DPiSnapshotUpdateEvent
	| DPiTurnStatsEvent
	| DPiErrorEvent;
