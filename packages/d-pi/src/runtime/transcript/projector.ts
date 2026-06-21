import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core/node";
import type { DPiAgentMessage } from "../types.ts";

export const DPiTranscriptCustomTypes = {
	boundary: "d-pi/transcript.boundary@v1",
	notice: "d-pi/transcript.notice@v1",
	steeringQueue: "d-pi/transcript.steering_queue@v1",
	toolState: "d-pi/transcript.tool_state@v1",
	turnStats: "d-pi/transcript.turn_stats@v1",
} as const;

export type DPiTranscriptBoundaryReason = "compact" | "fork" | "new" | "resume";
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
	const items = projectedEntries.flatMap((entry) => {
		const item = transcriptEntryToItem(entry);
		return item ? [item] : [];
	});
	const steeringQueue =
		latestSteeringQueue(entries) ?? createDPiTranscriptSteeringQueueEntry({ revision: 0, items: [], timestamp: 0 });
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

function latestBoundaryIndex(entries: readonly SessionTreeEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === DPiTranscriptCustomTypes.boundary) {
			return index;
		}
	}
	return -1;
}

function latestSteeringQueue(entries: readonly SessionTreeEntry[]): DPiTranscriptSteeringQueueEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		const queue = transcriptSteeringQueueFromEntry(entry);
		if (queue) {
			return queue;
		}
	}
	return undefined;
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
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	const reason = record.reason;
	const label = record.label;
	if (
		record.version !== 1 ||
		(reason !== "compact" && reason !== "fork" && reason !== "new" && reason !== "resume") ||
		typeof label !== "string"
	) {
		return undefined;
	}
	return {
		version: 1,
		reason,
		label,
		...(typeof record.summary === "string" ? { summary: record.summary } : {}),
		...(typeof record.tokensBefore === "number" ? { tokensBefore: record.tokensBefore } : {}),
		...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
		...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
	};
}

function transcriptToolStateFromEntry(
	entry: SessionTreeEntry,
): Omit<DPiTranscriptToolStateItem, "id" | "type"> | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.toolState) {
		return undefined;
	}
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	const status = record.status;
	if (
		record.version !== 1 ||
		typeof record.toolCallId !== "string" ||
		typeof record.toolName !== "string" ||
		(status !== "cancelled" && status !== "failed" && status !== "running" && status !== "succeeded")
	) {
		return undefined;
	}
	return {
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		status,
		timestamp: numberOr(record.timestamp, timestampFromEntry(entry)),
		...(record.args === undefined ? {} : { args: record.args }),
		...(record.result === undefined ? {} : { result: record.result }),
		...(typeof record.error === "string" ? { error: record.error } : {}),
	};
}

function transcriptTurnStatsFromEntry(
	entry: SessionTreeEntry,
): Omit<DPiTranscriptTurnStatsItem, "id" | "type"> | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.turnStats) {
		return undefined;
	}
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.tps !== "number" ||
		typeof record.output !== "number" ||
		typeof record.input !== "number" ||
		typeof record.cacheRead !== "number" ||
		typeof record.cacheWrite !== "number" ||
		typeof record.total !== "number" ||
		typeof record.duration !== "number"
	) {
		return undefined;
	}
	return {
		tps: record.tps,
		output: record.output,
		input: record.input,
		cacheRead: record.cacheRead,
		cacheWrite: record.cacheWrite,
		total: record.total,
		duration: record.duration,
		timestamp: numberOr(record.timestamp, timestampFromEntry(entry)),
	};
}

function transcriptNoticeFromEntry(entry: SessionTreeEntry): Omit<DPiTranscriptNoticeItem, "id" | "type"> | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.notice) {
		return undefined;
	}
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	const level = record.level;
	if (
		record.version !== 1 ||
		(level !== "error" && level !== "info" && level !== "warning") ||
		typeof record.text !== "string"
	) {
		return undefined;
	}
	return {
		level,
		text: record.text,
		timestamp: numberOr(record.timestamp, timestampFromEntry(entry)),
	};
}

function transcriptSteeringQueueFromEntry(entry: SessionTreeEntry): DPiTranscriptSteeringQueueEntry | undefined {
	if (entry.type !== "custom" || entry.customType !== DPiTranscriptCustomTypes.steeringQueue) {
		return undefined;
	}
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || typeof record.revision !== "number" || !Array.isArray(record.items)) {
		return undefined;
	}
	const items = record.items.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return [];
		}
		const itemRecord = item as Record<string, unknown>;
		if (typeof itemRecord.id !== "string" || typeof itemRecord.text !== "string") {
			return [];
		}
		return [
			{
				id: itemRecord.id,
				text: itemRecord.text,
				createdAt: numberOr(itemRecord.createdAt, timestampFromEntry(entry)),
				...(Array.isArray(itemRecord.images)
					? { images: itemRecord.images.flatMap((image) => steeringQueueImage(image)) }
					: {}),
			},
		];
	});
	return {
		version: 1,
		revision: record.revision,
		items,
		timestamp: numberOr(record.timestamp, timestampFromEntry(entry)),
		...(typeof record.runId === "string" ? { runId: record.runId } : {}),
	};
}

function steeringQueueImage(value: unknown): { url: string; mediaType?: string }[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [];
	}
	const record = value as Record<string, unknown>;
	if (typeof record.url !== "string") {
		return [];
	}
	return [
		{
			url: record.url,
			...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
		},
	];
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
