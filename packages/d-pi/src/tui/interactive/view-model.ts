import type { DPiInteractiveSessionStateSnapshot } from "./agent-session-proxy.ts";

export type DPiInteractiveStatusState = Omit<DPiInteractiveSessionStateSnapshot, "messages">;

export interface DPiInteractiveRealtimeMessage {
	id?: string;
	role?: string;
	content?: unknown;
	timestamp?: number;
}

export type DPiInteractiveRealtimePageReason = "compact" | "fork" | "initial" | "new" | "resume";

export interface DPiInteractiveRealtimePage {
	id: string;
	index: number;
	reason: DPiInteractiveRealtimePageReason;
	startedAt: number;
}

export interface DPiInteractiveRealtimeState {
	cursor: number;
	page: DPiInteractiveRealtimePage;
	messages: readonly DPiInteractiveRealtimeMessage[];
}

export type DPiInteractiveRealtimeEvent =
	| DPiInteractiveRealtimeSnapshotEvent
	| DPiInteractiveRealtimeUpsertEvent
	| DPiInteractiveRealtimeDeleteEvent;

export interface DPiInteractiveRealtimeSnapshotEvent {
	type: "snapshot";
	cursor: number;
	page: DPiInteractiveRealtimePage;
	messages: readonly DPiInteractiveRealtimeMessage[];
}

export interface DPiInteractiveRealtimeUpsertEvent {
	type: "upsert";
	cursor: number;
	message: DPiInteractiveRealtimeMessage;
}

export interface DPiInteractiveRealtimeDeleteEvent {
	type: "delete";
	cursor: number;
	id: string;
}

export function splitDPiInteractiveSnapshot(snapshot: DPiInteractiveSessionStateSnapshot): {
	status: DPiInteractiveStatusState;
	realtime: DPiInteractiveRealtimeState;
} {
	const { messages, ...status } = snapshot;
	return {
		status,
		realtime: {
			cursor: messages.length,
			page: createDPiInteractiveRealtimePage("initial", 0),
			messages: messages as readonly DPiInteractiveRealtimeMessage[],
		},
	};
}

export function createDPiInteractiveRealtimePage(
	reason: DPiInteractiveRealtimePageReason,
	index: number,
	startedAt = Date.now(),
): DPiInteractiveRealtimePage {
	return {
		id: `page-${index}-${startedAt}`,
		index,
		reason,
		startedAt,
	};
}

export function composeDPiInteractiveSnapshot(
	status: DPiInteractiveStatusState,
	realtime: DPiInteractiveRealtimeState,
): DPiInteractiveSessionStateSnapshot {
	return {
		...status,
		messages: realtime.messages as DPiInteractiveSessionStateSnapshot["messages"],
	};
}

export function applyDPiInteractiveRealtimeEvent(
	state: DPiInteractiveRealtimeState,
	event: DPiInteractiveRealtimeEvent,
): DPiInteractiveRealtimeState {
	if (event.type === "snapshot") {
		return { cursor: event.cursor, page: event.page, messages: [...event.messages] };
	}
	if (event.type === "delete") {
		return {
			cursor: event.cursor,
			page: state.page,
			messages: state.messages.filter((message) => message.id !== event.id),
		};
	}
	const index = event.message.id ? state.messages.findIndex((message) => message.id === event.message.id) : -1;
	if (index < 0) {
		return { cursor: event.cursor, page: state.page, messages: [...state.messages, event.message] };
	}
	const messages = [...state.messages];
	messages[index] = event.message;
	return { cursor: event.cursor, page: state.page, messages };
}

export function isDPiInteractiveStatusState(value: unknown): value is DPiInteractiveStatusState {
	return (
		typeof value === "object" &&
		value !== null &&
		!("messages" in value) &&
		"tokenUsage" in value &&
		"contextUsage" in value &&
		"remoteSettings" in value
	);
}

export function isDPiInteractiveRealtimeState(value: unknown): value is DPiInteractiveRealtimeState {
	return (
		typeof value === "object" &&
		value !== null &&
		"cursor" in value &&
		typeof value.cursor === "number" &&
		"page" in value &&
		isDPiInteractiveRealtimePage(value.page) &&
		"messages" in value &&
		Array.isArray(value.messages)
	);
}

function isDPiInteractiveRealtimePage(value: unknown): value is DPiInteractiveRealtimePage {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"index" in value &&
		typeof value.index === "number" &&
		"reason" in value &&
		(value.reason === "compact" ||
			value.reason === "fork" ||
			value.reason === "initial" ||
			value.reason === "new" ||
			value.reason === "resume") &&
		"startedAt" in value &&
		typeof value.startedAt === "number"
	);
}

export function isDPiInteractiveRealtimeEvent(value: unknown): value is DPiInteractiveRealtimeEvent {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return false;
	}
	if (value.type === "snapshot") {
		return isDPiInteractiveRealtimeState(value);
	}
	if (value.type === "upsert") {
		return "cursor" in value && typeof value.cursor === "number" && "message" in value;
	}
	return value.type === "delete" && "cursor" in value && typeof value.cursor === "number" && "id" in value;
}
