import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core/node";
import { z } from "zod";
import type { DPiAgentMessage } from "../types.ts";

export const DPiTranscriptCustomTypes = {
	boundary: "d-pi/transcript.boundary@v1",
	notice: "d-pi/transcript.notice@v1",
	steeringQueue: "d-pi/transcript.steering_queue@v1",
	toolState: "d-pi/transcript.tool_state@v1",
	turnStats: "d-pi/transcript.turn_stats@v1",
} as const;

const transcriptBoundarySchema = z.object({
	version: z.literal(1),
	reason: z.enum(["compact", "new", "resume"]),
	label: z.string(),
	summary: z.string().optional(),
	tokensBefore: z.number().optional(),
	durationMs: z.number().optional(),
	completedAt: z.number().optional(),
});

const transcriptToolStateSchema = z.object({
	version: z.literal(1),
	toolCallId: z.string(),
	toolName: z.string(),
	status: z.enum(["cancelled", "failed", "running", "succeeded"]),
	timestamp: z.number().optional(),
	args: z.unknown().optional(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

const transcriptTurnStatsSchema = z.object({
	version: z.literal(1),
	tps: z.number(),
	output: z.number(),
	input: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
	total: z.number(),
	duration: z.number(),
	timestamp: z.number().optional(),
});

const transcriptNoticeSchema = z.object({
	version: z.literal(1),
	level: z.enum(["error", "info", "warning"]),
	text: z.string(),
	timestamp: z.number().optional(),
});

export type DPiTranscriptBoundaryReason = "compact" | "new" | "resume";
export type DPiTranscriptNoticeLevel = "error" | "info" | "warning";
export type DPiTranscriptToolStatus = "cancelled" | "failed" | "running" | "succeeded";

export type DPiTranscriptItem =
	| DPiTranscriptBoundaryItem
	| DPiTranscriptMessageItem
	| DPiTranscriptNoticeItem
	| DPiTranscriptToolStateItem
	| DPiTranscriptTurnStatsItem;

export interface DPiTranscriptBaseItem {
	id: string;
	timestamp: number;
}

export interface DPiTranscriptMessageItem extends DPiTranscriptBaseItem {
	type: "message";
	message: DPiAgentMessage;
}

export interface DPiTranscriptBoundaryItem extends DPiTranscriptBaseItem, DPiTranscriptBoundaryEntry {
	type: "boundary";
}

export interface DPiTranscriptToolStateItem extends DPiTranscriptBaseItem {
	type: "tool_state";
	toolCallId: string;
	toolName: string;
	status: DPiTranscriptToolStatus;
	args?: unknown;
	result?: unknown;
	error?: string;
}

export interface DPiTranscriptTurnStatsItem extends DPiTranscriptBaseItem {
	type: "turn_stats";
	tps: number;
	output: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	duration: number;
}

export interface DPiTranscriptNoticeItem extends DPiTranscriptBaseItem {
	type: "notice";
	level: DPiTranscriptNoticeLevel;
	text: string;
}

export interface DPiTranscriptBoundaryEntry {
	version: 1;
	reason: DPiTranscriptBoundaryReason;
	label: string;
	summary?: string;
	tokensBefore?: number;
	durationMs?: number;
	completedAt?: number;
}

export interface DPiTranscriptToolStateEntry {
	version: 1;
	toolCallId: string;
	toolName: string;
	status: DPiTranscriptToolStatus;
	timestamp: number;
	args?: unknown;
	result?: unknown;
	error?: string;
}

export interface DPiTranscriptTurnStatsEntry {
	version: 1;
	tps: number;
	output: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	duration: number;
	timestamp: number;
}

export interface DPiTranscriptNoticeEntry {
	version: 1;
	level: DPiTranscriptNoticeLevel;
	text: string;
	timestamp: number;
}

export interface DPiTranscriptSteeringQueueItem {
	id: string;
	text: string;
	createdAt: number;
	images?: Array<{ url: string; mediaType?: string }>;
}

export interface DPiTranscriptSteeringQueueEntry {
	version: 1;
	revision: number;
	items: DPiTranscriptSteeringQueueItem[];
	timestamp: number;
	runId?: string;
}

export interface DPiTranscriptPage {
	id: string;
	index: number;
	reason: DPiTranscriptBoundaryReason | "initial";
	startedAt: number;
}

export interface DPiTranscriptProjection {
	page: DPiTranscriptPage;
	cursor: number;
	items: DPiTranscriptItem[];
	messages: DPiAgentMessage[];
	steeringQueue: DPiTranscriptSteeringQueueEntry;
}

export function createDPiTranscriptBoundaryEntry(
	options: Omit<DPiTranscriptBoundaryEntry, "version">,
): DPiTranscriptBoundaryEntry {
	return {
		version: 1,
		...options,
	};
}

export function createDPiTranscriptToolStateEntry(
	options: Omit<DPiTranscriptToolStateEntry, "version">,
): DPiTranscriptToolStateEntry {
	return {
		version: 1,
		...options,
	};
}

export function createDPiTranscriptTurnStatsEntry(
	options: Omit<DPiTranscriptTurnStatsEntry, "version">,
): DPiTranscriptTurnStatsEntry {
	return {
		version: 1,
		...options,
	};
}

export function createDPiTranscriptNoticeEntry(
	options: Omit<DPiTranscriptNoticeEntry, "version">,
): DPiTranscriptNoticeEntry {
	return {
		version: 1,
		...options,
	};
}

export function createDPiTranscriptSteeringQueueEntry(
	options: Omit<DPiTranscriptSteeringQueueEntry, "version">,
): DPiTranscriptSteeringQueueEntry {
	return {
		version: 1,
		...options,
	};
}

export function projectDPiTranscript(entries: readonly SessionTreeEntry[]): DPiTranscriptProjection {
	const boundaryIndex = latestBoundaryIndex(entries);
	const projectedEntries = boundaryIndex >= 0 ? entries.slice(boundaryIndex) : entries;
	const boundaryEntry = boundaryIndex >= 0 ? transcriptBoundaryFromEntry(entries[boundaryIndex]!) : undefined;
	const items = projectEntriesToItems(projectedEntries);
	const steeringQueue = createDPiTranscriptSteeringQueueEntry({ revision: 0, items: [], timestamp: 0 });
	const page: DPiTranscriptPage = {
		id: boundaryEntry ? `page-${boundaryEntry.reason}-${entryId(entries[boundaryIndex]!)}` : "page-initial",
		index: boundaryIndex >= 0 ? boundaryIndex : 0,
		reason: boundaryEntry?.reason ?? "initial",
		startedAt: boundaryEntry?.completedAt ?? timestampFromEntry(entries[boundaryIndex] ?? entries[0]),
	};
	return {
		page,
		cursor: entries.length,
		items,
		messages: items.flatMap((item) => {
			const message = transcriptItemToMessage(item);
			return message ? [message] : [];
		}),
		steeringQueue,
	};
}

function projectEntriesToItems(entries: readonly SessionTreeEntry[]): DPiTranscriptItem[] {
	const items: DPiTranscriptItem[] = [];
	const toolStateEntryIndexByCallId = new Map<string, number>();
	for (const entry of entries) {
		const item = transcriptEntryToItem(entry);
		if (!item) {
			continue;
		}
		if (item.type === "tool_state") {
			const existingIndex = toolStateEntryIndexByCallId.get(item.toolCallId);
			if (existingIndex !== undefined) {
				items[existingIndex] = item;
			} else {
				toolStateEntryIndexByCallId.set(item.toolCallId, items.length);
				items.push(item);
			}
		} else {
			items.push(item);
		}
	}
	return items;
}

function latestBoundaryIndex(entries: readonly SessionTreeEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === DPiTranscriptCustomTypes.boundary) {
			return index;
		}
	}
	return -1;
}

function transcriptEntryToItem(entry: SessionTreeEntry): DPiTranscriptItem | undefined {
	if (entry.type === "custom" && entry.customType === DPiTranscriptCustomTypes.boundary) {
		const boundary = transcriptBoundaryFromEntry(entry);
		if (!boundary) {
			return undefined;
		}
		return { id: entryId(entry), type: "boundary", timestamp: timestampFromEntry(entry), ...boundary };
	}
	if (entry.type === "custom" && entry.customType === DPiTranscriptCustomTypes.toolState) {
		const toolState = transcriptToolStateFromEntry(entry);
		return toolState ? { id: entryId(entry), type: "tool_state", ...toolState } : undefined;
	}
	if (entry.type === "custom" && entry.customType === DPiTranscriptCustomTypes.turnStats) {
		const turnStats = transcriptTurnStatsFromEntry(entry);
		return turnStats ? { id: entryId(entry), type: "turn_stats", ...turnStats } : undefined;
	}
	if (entry.type === "custom" && entry.customType === DPiTranscriptCustomTypes.notice) {
		const notice = transcriptNoticeFromEntry(entry);
		return notice ? { id: entryId(entry), type: "notice", ...notice } : undefined;
	}
	if (entry.type === "message") {
		return {
			id: entryId(entry),
			type: "message",
			message: entry.message as AgentMessage,
			timestamp: timestampFromEntry(entry),
		};
	}
	if (entry.type === "custom_message") {
		return {
			id: entryId(entry),
			type: "message",
			message: {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				...(entry.details === undefined ? {} : { details: entry.details }),
				timestamp: timestampFromEntry(entry),
			},
			timestamp: timestampFromEntry(entry),
		};
	}
	return undefined;
}

function transcriptItemToMessage(item: DPiTranscriptItem): DPiAgentMessage | undefined {
	if (item.type === "boundary") {
		return {
			role: "custom",
			customType: "compact-divider",
			display: true,
			content: item.label,
			details: {
				reason: item.reason,
				...(item.summary === undefined ? {} : { summary: item.summary }),
				...(item.tokensBefore === undefined ? {} : { tokensBefore: item.tokensBefore }),
				...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
				...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
			},
			timestamp: item.timestamp,
		};
	}
	if (item.type === "message") {
		return item.message;
	}
	return undefined;
}

function transcriptBoundaryFromEntry(entry: SessionTreeEntry): DPiTranscriptBoundaryEntry | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.boundary) {
		return undefined;
	}
	const parsed = transcriptBoundarySchema.safeParse(entry.data);
	if (!parsed.success) {
		return undefined;
	}
	return parsed.data;
}

function transcriptToolStateFromEntry(
	entry: SessionTreeEntry,
): Omit<DPiTranscriptToolStateItem, "id" | "type"> | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.toolState) {
		return undefined;
	}
	const parsed = transcriptToolStateSchema.safeParse(entry.data);
	if (!parsed.success) {
		return undefined;
	}
	const { version, ...rest } = parsed.data;
	void version;
	return {
		...rest,
		timestamp: numberOr(rest.timestamp, timestampFromEntry(entry)),
	};
}

function transcriptTurnStatsFromEntry(
	entry: SessionTreeEntry,
): Omit<DPiTranscriptTurnStatsItem, "id" | "type"> | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.turnStats) {
		return undefined;
	}
	const parsed = transcriptTurnStatsSchema.safeParse(entry.data);
	if (!parsed.success) {
		return undefined;
	}
	const { version, ...rest } = parsed.data;
	void version;
	return {
		...rest,
		timestamp: numberOr(rest.timestamp, timestampFromEntry(entry)),
	};
}

function transcriptNoticeFromEntry(entry: SessionTreeEntry): Omit<DPiTranscriptNoticeItem, "id" | "type"> | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.notice) {
		return undefined;
	}
	const parsed = transcriptNoticeSchema.safeParse(entry.data);
	if (!parsed.success) {
		return undefined;
	}
	const { version, ...rest } = parsed.data;
	void version;
	return {
		...rest,
		timestamp: numberOr(rest.timestamp, timestampFromEntry(entry)),
	};
}

function timestampFromEntry(entry: SessionTreeEntry | undefined): number {
	if (!entry) {
		return Date.now();
	}
	return Date.parse(entry.timestamp);
}

function entryId(entry: SessionTreeEntry): string {
	return entry.id;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
