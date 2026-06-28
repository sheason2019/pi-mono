import { z } from "zod";
import type { DPiTranscriptItem } from "../../runtime/transcript/projector.ts";
import type { DPiInteractiveSessionStateSnapshot } from "./agent-session-proxy.ts";

export type DPiInteractiveStatusState = Omit<DPiInteractiveSessionStateSnapshot, "messages" | "transcriptItems">;

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
	items: readonly DPiTranscriptItem[];
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
	items?: readonly DPiTranscriptItem[];
	messages: readonly DPiInteractiveRealtimeMessage[];
}

export interface DPiInteractiveRealtimeUpsertEvent {
	type: "upsert";
	cursor: number;
	item?: DPiTranscriptItem;
	message?: DPiInteractiveRealtimeMessage;
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
	const { messages, transcriptItems, ...status } = snapshot;
	return {
		status,
		realtime: {
			cursor: messages.length,
			page: createDPiInteractiveRealtimePage("initial", 0),
			items: transcriptItems ?? [],
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
		...(realtime.items.length > 0 ? { transcriptItems: realtime.items } : {}),
	};
}

export function applyDPiInteractiveRealtimeEvent(
	state: DPiInteractiveRealtimeState,
	event: DPiInteractiveRealtimeEvent,
): DPiInteractiveRealtimeState {
	if (event.type === "snapshot") {
		return {
			cursor: event.cursor,
			page: event.page,
			items: event.items ? [...event.items] : [],
			messages: [...event.messages],
		};
	}
	if (event.type === "delete") {
		return {
			cursor: event.cursor,
			page: state.page,
			items: state.items.filter((item) => item.id !== event.id),
			messages: state.messages.filter((message) => message.id !== event.id),
		};
	}
	if (!event.item && !event.message) {
		return { ...state, cursor: event.cursor };
	}
	const item = event.item ?? messageToTranscriptItem(event.message!);
	const itemIndex = state.items.findIndex((candidate) => candidate.id === item.id);
	const items =
		itemIndex < 0
			? [...state.items, item]
			: state.items.map((candidate, candidateIndex) => (candidateIndex === itemIndex ? item : candidate));
	if (!event.message) {
		return { cursor: event.cursor, page: state.page, items, messages: state.messages };
	}
	const index = event.message.id ? state.messages.findIndex((message) => message.id === event.message!.id) : -1;
	if (index < 0) {
		return { cursor: event.cursor, page: state.page, items, messages: [...state.messages, event.message] };
	}
	const messages = [...state.messages];
	messages[index] = event.message;
	return { cursor: event.cursor, page: state.page, items, messages };
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
		Array.isArray(value.messages) &&
		(!("items" in value) || Array.isArray(value.items))
	);
}

const dPiInteractiveRealtimePageSchema = z.object({
	id: z.string(),
	index: z.number(),
	reason: z.enum(["compact", "fork", "initial", "new", "resume"]),
	startedAt: z.number(),
});

function isDPiInteractiveRealtimePage(value: unknown): value is DPiInteractiveRealtimePage {
	return dPiInteractiveRealtimePageSchema.safeParse(value).success;
}

export function isDPiInteractiveRealtimeEvent(value: unknown): value is DPiInteractiveRealtimeEvent {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return false;
	}
	if (value.type === "snapshot") {
		return isDPiInteractiveRealtimeState(value);
	}
	if (value.type === "upsert") {
		return "cursor" in value && typeof value.cursor === "number" && ("message" in value || "item" in value);
	}
	return value.type === "delete" && "cursor" in value && typeof value.cursor === "number" && "id" in value;
}

function messageToTranscriptItem(message: DPiInteractiveRealtimeMessage): DPiTranscriptItem {
	return {
		id: message.id ?? `message-${message.timestamp ?? 0}`,
		type: "message",
		message: message as DPiInteractiveSessionStateSnapshot["messages"][number],
		timestamp: message.timestamp ?? Date.now(),
	};
}
