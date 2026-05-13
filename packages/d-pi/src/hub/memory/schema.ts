export const MEMORY_SCHEMA_VERSION = 1;

export interface MemoryItem {
	id: string;
	agentId: string;
	sessionFile: string;
	sessionEntryId: string;
	parentEntryId: string | null;
	entryIndex: number;
	timestamp: string;
	role: string;
	kind: string;
	text: string;
	rawJson: string;
	modelProvider: string | null;
	modelId: string | null;
	toolName: string | null;
	hasToolContent: boolean;
	updatedAt: string;
}

export interface NewMemoryItem {
	id: string;
	agentId: string;
	sessionFile: string;
	sessionEntryId: string;
	parentEntryId?: string | null;
	entryIndex: number;
	timestamp: string;
	role: string;
	kind: string;
	text: string;
	rawJson: string;
	modelProvider?: string | null;
	modelId?: string | null;
	toolName?: string | null;
	hasToolContent: boolean;
	updatedAt: string;
}
