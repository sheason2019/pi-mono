import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const MEMORY_SCHEMA_VERSION = 1;

export const memoryItems = sqliteTable(
	"memory_items",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id").notNull(),
		sessionFile: text("session_file").notNull(),
		sessionEntryId: text("session_entry_id").notNull(),
		parentEntryId: text("parent_entry_id"),
		entryIndex: integer("entry_index").notNull(),
		timestamp: text("timestamp").notNull(),
		role: text("role").notNull(),
		kind: text("kind").notNull(),
		text: text("text").notNull(),
		rawJson: text("raw_json").notNull(),
		modelProvider: text("model_provider"),
		modelId: text("model_id"),
		toolName: text("tool_name"),
		hasToolContent: integer("has_tool_content", { mode: "boolean" }).notNull().default(false),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("memory_items_agent_session_entry_idx").on(table.agentId, table.sessionFile, table.sessionEntryId),
		index("memory_items_session_order_idx").on(table.agentId, table.sessionFile, table.entryIndex),
		index("memory_items_agent_timestamp_idx").on(table.agentId, table.timestamp),
	],
);

export type MemoryItem = typeof memoryItems.$inferSelect;
export type NewMemoryItem = typeof memoryItems.$inferInsert;
