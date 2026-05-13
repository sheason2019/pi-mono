import { mkdirSync } from "node:fs";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { and, eq, inArray } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { getMemoryDbFile, getWorkspaceDir } from "../config.js";
import { MEMORY_SCHEMA_VERSION, type MemoryItem, memoryItems, type NewMemoryItem } from "./schema.js";
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

export class MemoryStore {
	private constructor(
		private readonly sqlite: Database.Database,
		private readonly db: BetterSQLite3Database<{ memoryItems: typeof memoryItems }>,
	) {}

	static open(cwd: string): MemoryStore {
		mkdirSync(getWorkspaceDir(cwd), { recursive: true });
		const sqlite = new Database(getMemoryDbFile(cwd));
		const db = drizzle(sqlite, { schema: { memoryItems } });
		const store = new MemoryStore(sqlite, db);
		store.initialize();
		return store;
	}

	close(): void {
		this.sqlite.close();
	}

	indexSession(input: IndexSessionInput): void {
		const rows = input.entries
			.map((entry, index) => this.entryToMemoryItem(input.agentId, input.sessionFile, entry, index))
			.filter((row): row is NewMemoryItem => row !== undefined);
		const transaction = this.sqlite.transaction((items: NewMemoryItem[]) => {
			for (const item of items) {
				this.db
					.insert(memoryItems)
					.values(item)
					.onConflictDoUpdate({
						target: memoryItems.id,
						set: {
							agentId: item.agentId,
							sessionFile: item.sessionFile,
							sessionEntryId: item.sessionEntryId,
							parentEntryId: item.parentEntryId,
							entryIndex: item.entryIndex,
							timestamp: item.timestamp,
							role: item.role,
							kind: item.kind,
							text: item.text,
							rawJson: item.rawJson,
							modelProvider: item.modelProvider,
							modelId: item.modelId,
							toolName: item.toolName,
							hasToolContent: item.hasToolContent,
							updatedAt: item.updatedAt,
						},
					})
					.run();
				this.upsertFtsRow(item);
			}
		});
		transaction(rows);
	}

	search(input: SearchMemoryInput): SearchMemoryResult[] {
		const ftsQuery = buildFtsQuery(input.query);
		if (!ftsQuery) {
			return [];
		}
		const limit = normalizeLimit(input.limit, 20, 100);
		const conditions: string[] = ["memory_fts MATCH ?"];
		const params: unknown[] = [ftsQuery];
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
		const rows = this.sqlite
			.prepare(
				`SELECT f.item_id AS memoryId, bm25(memory_fts) AS score
				FROM memory_fts AS f
				JOIN memory_items AS i ON i.id = f.item_id
				WHERE ${conditions.join(" AND ")}
				ORDER BY score ASC
				LIMIT ?`,
			)
			.all(...params) as SearchDbRow[];
		const items = this.getItemsByIds(rows.map((row) => row.memoryId));
		return rows.flatMap((row) => {
			const item = items.get(row.memoryId);
			return item ? [toSearchMemoryResult(item, row.score)] : [];
		});
	}

	list(input: ListMemoryInput): MemoryContextResult[] {
		if (input.memoryIds.length === 0) {
			return [];
		}
		const before = normalizeContext(input.contextBefore, 3);
		const after = normalizeContext(input.contextAfter, 3);
		const hits = this.getItemsByIds(input.memoryIds);
		return input.memoryIds.flatMap((memoryId) => {
			const hit = hits.get(memoryId);
			if (!hit || !isAgentInScope(hit.agentId, input.scopeAgentIds)) {
				return [];
			}
			const rows = this.db
				.select()
				.from(memoryItems)
				.where(
					and(
						eq(memoryItems.agentId, hit.agentId),
						eq(memoryItems.sessionFile, hit.sessionFile),
						inArray(memoryItems.entryIndex, range(hit.entryIndex - before, hit.entryIndex + after)),
					),
				)
				.orderBy(memoryItems.entryIndex)
				.all();
			return [
				{
					memoryId: hit.id,
					agentId: hit.agentId,
					sessionFile: hit.sessionFile,
					sessionEntryId: hit.sessionEntryId,
					items: rows.map(toListedMemoryItem),
				},
			];
		});
	}

	private initialize(): void {
		this.sqlite.pragma("journal_mode = WAL");
		this.sqlite.exec(`
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

	private upsertFtsRow(item: NewMemoryItem): void {
		const tokenizedText = buildTokenizedMemoryText(item.text, [
			item.agentId,
			item.role,
			item.kind,
			item.modelProvider ?? "",
			item.modelId ?? "",
			item.toolName ?? "",
		]);
		this.sqlite.prepare("DELETE FROM memory_fts WHERE item_id = ?").run(item.id);
		this.sqlite
			.prepare("INSERT INTO memory_fts(item_id, agent_id, tokenized_text) VALUES (?, ?, ?)")
			.run(item.id, item.agentId, tokenizedText);
	}

	private getItemsByIds(ids: string[]): Map<string, MemoryItem> {
		if (ids.length === 0) {
			return new Map();
		}
		const rows = this.db.select().from(memoryItems).where(inArray(memoryItems.id, ids)).all();
		return new Map(rows.map((row) => [row.id, row]));
	}
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

function range(start: number, end: number): number[] {
	const values: number[] = [];
	for (let value = start; value <= end; value += 1) {
		values.push(value);
	}
	return values;
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
