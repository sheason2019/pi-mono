import type { HubQueuedInputMessage, HubRunEndReason, HubRunTiming } from "./session-snapshot.js";

export type HubSessionEventType = "snapshot_updated" | "run_state_changed" | "queue_changed" | "error";

export interface HubSessionEventBase {
	seq: number;
	timestamp: string;
	type: HubSessionEventType;
}

export interface HubSessionSnapshotUpdatedEvent extends HubSessionEventBase {
	type: "snapshot_updated";
}

export interface HubSessionRunStateChangedEvent extends HubSessionEventBase {
	type: "run_state_changed";
	isRunning: boolean;
	runStartedAt?: string;
	lastRunStartedAt?: string;
	lastRunEndedAt?: string;
	lastRunDurationMs?: number;
	lastRunEndReason?: HubRunEndReason;
	lastError?: string;
	runTiming?: HubRunTiming;
}

export interface HubSessionQueueChangedEvent extends HubSessionEventBase {
	type: "queue_changed";
	messages: HubQueuedInputMessage[];
}

export interface HubSessionErrorEvent extends HubSessionEventBase {
	type: "error";
	message: string;
}

export type HubSessionEvent =
	| HubSessionSnapshotUpdatedEvent
	| HubSessionRunStateChangedEvent
	| HubSessionQueueChangedEvent
	| HubSessionErrorEvent;
