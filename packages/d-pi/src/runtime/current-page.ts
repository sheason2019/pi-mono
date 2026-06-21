import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core/node";
import type { DPiAgentMessage } from "./types.ts";

export const DPI_COMPACT_DIVIDER_ENTRY_TYPE = "d-pi-compact-divider";

export interface DPiPersistedCompactDivider {
	label: string;
	summary?: string;
	tokensBefore?: number;
	durationMs?: number;
	completedAt?: number;
}

export function buildDPiCurrentPageMessagesFromSessionEntries(entries: readonly SessionTreeEntry[]): DPiAgentMessage[] {
	const dividerIndex = latestCompactDividerIndex(entries);
	if (dividerIndex < 0) {
		return [];
	}
	const divider = compactDividerMessageFromEntry(entries[dividerIndex]!);
	const messages = entries.slice(dividerIndex + 1).flatMap((entry) => {
		const message = sessionEntryToMessage(entry);
		return message ? [message] : [];
	});
	return [divider, ...messages];
}

export function createDPiPersistedCompactDivider(
	label: string,
	summary: string,
	tokensBefore: number,
	durationMs: number,
	completedAt: number,
): DPiPersistedCompactDivider {
	return {
		label,
		summary,
		tokensBefore,
		durationMs,
		completedAt,
	};
}

function latestCompactDividerIndex(entries: readonly SessionTreeEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === DPI_COMPACT_DIVIDER_ENTRY_TYPE) {
			return index;
		}
	}
	return -1;
}

function compactDividerMessageFromEntry(entry: SessionTreeEntry): DPiAgentMessage {
	const divider = persistedCompactDividerFromData(entry.type === "custom" ? entry.data : undefined);
	return {
		role: "custom",
		customType: "compact-divider",
		display: true,
		content: divider.label,
		details: {
			...(divider.summary === undefined ? {} : { summary: divider.summary }),
			...(divider.tokensBefore === undefined ? {} : { tokensBefore: divider.tokensBefore }),
			...(divider.durationMs === undefined ? {} : { durationMs: divider.durationMs }),
			...(divider.completedAt === undefined ? {} : { completedAt: divider.completedAt }),
		},
		timestamp: Date.parse(entry.timestamp),
	};
}

function persistedCompactDividerFromData(data: unknown): DPiPersistedCompactDivider {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { label: "Compact completed" };
	}
	const record = data as Record<string, unknown>;
	return {
		label: typeof record.label === "string" ? record.label : "Compact completed",
		...(typeof record.summary === "string" ? { summary: record.summary } : {}),
		...(typeof record.tokensBefore === "number" ? { tokensBefore: record.tokensBefore } : {}),
		...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
		...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
	};
}

function sessionEntryToMessage(entry: SessionTreeEntry): DPiAgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			...(entry.details === undefined ? {} : { details: entry.details }),
			timestamp: Date.parse(entry.timestamp),
		};
	}
	return undefined;
}
