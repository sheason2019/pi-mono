import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { type Client, createClient, type InValue, type Row } from "@libsql/client";
import { getMemoryDbFile, getWorkspaceDir } from "../config.js";
import { MEMORY_SCHEMA_VERSION, type MemoryItem, type NewMemoryItem } from "./schema.js";
import { buildFtsQuery, buildTokenizedMemoryText } from "./tokenizer.js";

export interface IndexSessionInput {
	agentId: string;
	sessionFile: string;
	entries: SessionEntry[];
}

export interface SearchMemoryInput {
	query: string;
	agentId?: string;
	limit?: number;
	includeToolResults?: boolean;
	scopeAgentIds?: string[];
}

export interface SearchMemoryResult {
	memoryId: string;
	agentId: string;
	sessionEntryId: string;
	timestamp: string;
	role: string;
	kind: string;
	text: string;
	score: number;
	modelProvider?: string;
	modelId?: string;
	toolName?: string;
}

export interface ListMemoryInput {
	memoryIds: string[];
	contextBefore?: number;
	contextAfter?: number;
	scopeAgentIds?: string[];
}

export interface MemoryContextResult {
	memoryId: string;
	agentId: string;
	sessionFile: string;
	sessionEntryId: string;
	items: ListedMemoryItem[];
}

export interface ListedMemoryItem {
	memoryId: string;
	sessionEntryId: string;
	parentEntryId?: string;
	timestamp: string;
	role: string;
	kind: string;
	text: string;
	modelProvider?: string;
	modelId?: string;
	toolName?: string;
	rawJson: unknown;
}

interface SearchDbRow {
	memoryId: string;
	score: number;
}

const MEMORY_ITEM_SELECT_COLUMNS = `
	id,
	agent_id AS agentId,
	session_file AS sessionFile,
	session_entry_id AS sessionEntryId,
	parent_entry_id AS parentEntryId,
	entry_index AS entryIndex,
	timestamp,
	role,
	kind,
	text,
	raw_json AS rawJson,
	model_provider AS modelProvider,
	model_id AS modelId,
	tool_name AS toolName,
	has_tool_content AS hasToolContent,
	updated_at AS updatedAt
`;

export class MemoryStore {
	private readonly ready: Promise<void>;

	private constructor(private readonly client: Client) {
		this.ready = this.initialize();
	}

	static open(cwd: string): MemoryStore {
		mkdirSync(getWorkspaceDir(cwd), { recursive: true });
		return new MemoryStore(createClient({ url: pathToFileURL(getMemoryDbFile(cwd)).href }));
	}

	close(): void {
		this.client.close();
	}

	async indexSession(input: IndexSessionInput): Promise<void> {
		await this.ready;
		const rows = input.entries
			.map((entry, index) => this.entryToMemoryItem(input.agentId, input.sessionFile, entry, index))
			.filter((row): row is NewMemoryItem => row !== undefined);
		if (rows.length === 0) {
			return;
		}
		await this.client.batch(
			rows.flatMap((item) => [upsertMemoryItemStatement(item), ...upsertFtsRowStatements(item)]),
			"write",
		);
	}

	async search(input: SearchMemoryInput): Promise<SearchMemoryResult[]> {
		await this.ready;
		const ftsQuery = buildFtsQuery(input.query);
		if (!ftsQuery) {
			return [];
		}
		const limit = normalizeLimit(input.limit, 20, 100);
		const conditions: string[] = ["memory_fts MATCH ?"];
		const params: InValue[] = [ftsQuery];
		if (input.agentId) {
			conditions.push("i.agent_id = ?");
			params.push(input.agentId);
		}
		if (input.scopeAgentIds && input.scopeAgentIds.length === 0) {
			return [];
		}
		if (input.scopeAgentIds && input.scopeAgentIds.length > 0) {
			conditions.push(`i.agent_id IN (${input.scopeAgentIds.map(() => "?").join(", ")})`);
			params.push(...input.scopeAgentIds);
		}
		if (input.includeToolResults === false) {
			conditions.push("i.has_tool_content = 0");
		}
		params.push(limit);
		const result = await this.client.execute({
			sql: `SELECT f.item_id AS memoryId, bm25(memory_fts) AS score
				FROM memory_fts AS f
				JOIN memory_items AS i ON i.id = f.item_id
				WHERE ${conditions.join(" AND ")}
				ORDER BY score ASC
				LIMIT ?`,
			args: params as InValue[],
		});
		const rows = result.rows.map(
			(row): SearchDbRow => ({ memoryId: String(row.memoryId), score: Number(row.score) }),
		);
		const items = await this.getItemsByIds(rows.map((row) => row.memoryId));
		return rows.flatMap((row) => {
			const item = items.get(row.memoryId);
			return item ? [toSearchMemoryResult(item, row.score)] : [];
		});
	}

	async list(input: ListMemoryInput): Promise<MemoryContextResult[]> {
		await this.ready;
		if (input.memoryIds.length === 0) {
			return [];
		}
		const before = normalizeContext(input.contextBefore, 3);
		const after = normalizeContext(input.contextAfter, 3);
		const hits = await this.getItemsByIds(input.memoryIds);
		const contexts: MemoryContextResult[] = [];
		for (const memoryId of input.memoryIds) {
			const hit = hits.get(memoryId);
			if (!hit || !isAgentInScope(hit.agentId, input.scopeAgentIds)) {
				continue;
			}
			const rows = await this.getSessionItemsInRange(hit, hit.entryIndex - before, hit.entryIndex + after);
			contexts.push({
				memoryId: hit.id,
				agentId: hit.agentId,
				sessionFile: hit.sessionFile,
				sessionEntryId: hit.sessionEntryId,
				items: rows.map(toListedMemoryItem),
			});
		}
		return contexts;
	}

	private async initialize(): Promise<void> {
		await this.client.execute("PRAGMA journal_mode = WAL");
		await this.client.executeMultiple(`
			CREATE TABLE IF NOT EXISTS memory_items (
				id TEXT PRIMARY KEY NOT NULL,
				agent_id TEXT NOT NULL,
				session_file TEXT NOT NULL,
				session_entry_id TEXT NOT NULL,
				parent_entry_id TEXT,
				entry_index INTEGER NOT NULL,
				timestamp TEXT NOT NULL,
				role TEXT NOT NULL,
				kind TEXT NOT NULL,
				text TEXT NOT NULL,
				raw_json TEXT NOT NULL,
				model_provider TEXT,
				model_id TEXT,
				tool_name TEXT,
				has_tool_content INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS memory_items_agent_session_entry_idx
				ON memory_items(agent_id, session_file, session_entry_id);
			CREATE INDEX IF NOT EXISTS memory_items_session_order_idx
				ON memory_items(agent_id, session_file, entry_index);
			CREATE INDEX IF NOT EXISTS memory_items_agent_timestamp_idx
				ON memory_items(agent_id, timestamp);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
				item_id UNINDEXED,
				agent_id UNINDEXED,
				tokenized_text
			);
			PRAGMA user_version = ${MEMORY_SCHEMA_VERSION};
		`);
	}

	private entryToMemoryItem(
		agentId: string,
		sessionFile: string,
		entry: SessionEntry,
		entryIndex: number,
	): NewMemoryItem | undefined {
		if (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "compaction") {
			return undefined;
		}
		const text = extractEntryText(entry);
		if (!text.trim()) {
			return undefined;
		}
		const model = extractEntryModel(entry);
		const toolName = extractToolName(entry);
		const role = extractEntryRole(entry);
		return {
			id: createMemoryId(agentId, entry.id),
			agentId,
			sessionFile,
			sessionEntryId: entry.id,
			parentEntryId: entry.parentId,
			entryIndex,
			timestamp: entry.timestamp,
			role,
			kind: entry.type,
			text,
			rawJson: JSON.stringify(entry),
			modelProvider: model?.provider,
			modelId: model?.modelId,
			toolName,
			hasToolContent: hasToolContent(entry),
			updatedAt: new Date().toISOString(),
		};
	}

	private async getItemsByIds(ids: string[]): Promise<Map<string, MemoryItem>> {
		if (ids.length === 0) {
			return new Map();
		}
		const result = await this.client.execute({
			sql: `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
				FROM memory_items
				WHERE id IN (${ids.map(() => "?").join(", ")})`,
			args: ids,
		});
		const rows = result.rows.map(rowToMemoryItem);
		return new Map(rows.map((row) => [row.id, row]));
	}

	private async getSessionItemsInRange(hit: MemoryItem, fromIndex: number, toIndex: number): Promise<MemoryItem[]> {
		const result = await this.client.execute({
			sql: `SELECT ${MEMORY_ITEM_SELECT_COLUMNS}
				FROM memory_items
				WHERE agent_id = ? AND session_file = ? AND entry_index BETWEEN ? AND ?
				ORDER BY entry_index`,
			args: [hit.agentId, hit.sessionFile, fromIndex, toIndex],
		});
		return result.rows.map(rowToMemoryItem);
	}
}

function upsertMemoryItemStatement(item: NewMemoryItem): { sql: string; args: InValue[] } {
	return {
		sql: `INSERT INTO memory_items (
				id,
				agent_id,
				session_file,
				session_entry_id,
				parent_entry_id,
				entry_index,
				timestamp,
				role,
				kind,
				text,
				raw_json,
				model_provider,
				model_id,
				tool_name,
				has_tool_content,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				agent_id = excluded.agent_id,
				session_file = excluded.session_file,
				session_entry_id = excluded.session_entry_id,
				parent_entry_id = excluded.parent_entry_id,
				entry_index = excluded.entry_index,
				timestamp = excluded.timestamp,
				role = excluded.role,
				kind = excluded.kind,
				text = excluded.text,
				raw_json = excluded.raw_json,
				model_provider = excluded.model_provider,
				model_id = excluded.model_id,
				tool_name = excluded.tool_name,
				has_tool_content = excluded.has_tool_content,
				updated_at = excluded.updated_at`,
		args: [
			item.id,
			item.agentId,
			item.sessionFile,
			item.sessionEntryId,
			item.parentEntryId ?? null,
			item.entryIndex,
			item.timestamp,
			item.role,
			item.kind,
			item.text,
			item.rawJson,
			item.modelProvider ?? null,
			item.modelId ?? null,
			item.toolName ?? null,
			item.hasToolContent ? 1 : 0,
			item.updatedAt,
		],
	};
}

function upsertFtsRowStatements(item: NewMemoryItem): Array<{ sql: string; args: InValue[] }> {
	const tokenizedText = buildTokenizedMemoryText(item.text, [
		item.agentId,
		item.role,
		item.kind,
		item.modelProvider ?? "",
		item.modelId ?? "",
		item.toolName ?? "",
	]);
	return [
		{ sql: "DELETE FROM memory_fts WHERE item_id = ?", args: [item.id] },
		{
			sql: "INSERT INTO memory_fts(item_id, agent_id, tokenized_text) VALUES (?, ?, ?)",
			args: [item.id, item.agentId, tokenizedText],
		},
	];
}

function rowToMemoryItem(row: Row): MemoryItem {
	return {
		id: stringValue(row.id),
		agentId: stringValue(row.agentId),
		sessionFile: stringValue(row.sessionFile),
		sessionEntryId: stringValue(row.sessionEntryId),
		parentEntryId: optionalStringValue(row.parentEntryId),
		entryIndex: numberValue(row.entryIndex),
		timestamp: stringValue(row.timestamp),
		role: stringValue(row.role),
		kind: stringValue(row.kind),
		text: stringValue(row.text),
		rawJson: stringValue(row.rawJson),
		modelProvider: optionalStringValue(row.modelProvider),
		modelId: optionalStringValue(row.modelId),
		toolName: optionalStringValue(row.toolName),
		hasToolContent: Boolean(row.hasToolContent),
		updatedAt: stringValue(row.updatedAt),
	};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function optionalStringValue(value: unknown): string | null {
	return value === null || value === undefined ? null : stringValue(value);
}

function numberValue(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

function createMemoryId(agentId: string, sessionEntryId: string): string {
	return `${agentId}:${sessionEntryId}`;
}

function extractEntryRole(entry: SessionEntry): string {
	if (entry.type === "message") {
		return String(entry.message.role);
	}
	return entry.type;
}

function extractEntryText(entry: SessionEntry): string {
	if (entry.type === "compaction") {
		return entry.summary;
	}
	if (entry.type === "custom_message") {
		return contentToText(entry.content);
	}
	if (entry.type === "message") {
		return messageToText(entry.message);
	}
	return "";
}

function messageToText(message: SessionMessageEntry["message"]): string {
	const maybeContent = message as { content?: unknown };
	const contentText = contentToText(maybeContent.content);
	if (contentText) {
		return contentText;
	}
	return JSON.stringify(message);
}

function contentToText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && "type" in part && "text" in part) {
					return String((part as { text: unknown }).text);
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function extractEntryModel(entry: SessionEntry): { provider: string; modelId: string } | undefined {
	if (entry.type !== "message") {
		return undefined;
	}
	const message = entry.message as { provider?: unknown; model?: unknown };
	const provider = typeof message.provider === "string" ? message.provider : undefined;
	const modelId = typeof message.model === "string" ? message.model : undefined;
	return provider && modelId ? { provider, modelId } : undefined;
}

function extractToolName(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") {
		return undefined;
	}
	const message = entry.message as { toolName?: unknown };
	return typeof message.toolName === "string" ? message.toolName : undefined;
}

function hasToolContent(entry: SessionEntry): boolean {
	if (entry.type !== "message") {
		return false;
	}
	const message = entry.message as { role?: unknown; content?: unknown; toolCalls?: unknown[] };
	if (message.role === "toolResult") {
		return true;
	}
	if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
		return true;
	}
	return Array.isArray(message.content)
		? message.content.some((part) => part && typeof part === "object" && "type" in part && part.type === "toolCall")
		: false;
}

function normalizeLimit(limit: number | undefined, defaultValue: number, maxValue: number): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return defaultValue;
	}
	return Math.max(1, Math.min(maxValue, Math.floor(limit)));
}

function normalizeContext(value: number | undefined, defaultValue: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return defaultValue;
	}
	return Math.max(0, Math.min(20, Math.floor(value)));
}

function isAgentInScope(agentId: string, scopeAgentIds: string[] | undefined): boolean {
	return !scopeAgentIds || scopeAgentIds.includes(agentId);
}

function toSearchMemoryResult(item: MemoryItem, score: number): SearchMemoryResult {
	return {
		memoryId: item.id,
		agentId: item.agentId,
		sessionEntryId: item.sessionEntryId,
		timestamp: item.timestamp,
		role: item.role,
		kind: item.kind,
		text: item.text,
		score,
		...(item.modelProvider === null ? {} : { modelProvider: item.modelProvider }),
		...(item.modelId === null ? {} : { modelId: item.modelId }),
		...(item.toolName === null ? {} : { toolName: item.toolName }),
	};
}

function toListedMemoryItem(item: MemoryItem): ListedMemoryItem {
	let rawJson: unknown = null;
	try {
		rawJson = JSON.parse(item.rawJson);
	} catch {
		rawJson = item.rawJson;
	}
	return {
		memoryId: item.id,
		sessionEntryId: item.sessionEntryId,
		...(item.parentEntryId === null ? {} : { parentEntryId: item.parentEntryId }),
		timestamp: item.timestamp,
		role: item.role,
		kind: item.kind,
		text: item.text,
		...(item.modelProvider === null ? {} : { modelProvider: item.modelProvider }),
		...(item.modelId === null ? {} : { modelId: item.modelId }),
		...(item.toolName === null ? {} : { toolName: item.toolName }),
		rawJson,
	};
}
