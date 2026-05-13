import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { getMemoryDbFile } from "../../src/hub/config.js";
import { MemoryStore } from "../../src/hub/memory/memory-store.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("MemoryStore", () => {
	it("indexes Chinese session messages with jieba tokens and returns expandable context", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-memory-store-"));
		tempDirs.push(cwd);
		const paths = initializeWorkspace(cwd).paths;
		const sessionFile = paths.sessionFile;
		const sm = SessionManager.open(sessionFile, paths.workspaceDir, cwd);
		const t0 = Date.now();
		sm.appendMessage({ role: "user", content: "请记住：飞书消息中心需要优先处理审批通知", timestamp: t0 });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "已经记录飞书消息中心的审批通知优先级。" }],
			api: "test",
			provider: "openai",
			model: "gpt-4.1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: t0 + 1,
		});
		const store = MemoryStore.open(cwd);

		await store.indexSession({ agentId: "root", sessionFile, entries: sm.getEntries() });
		await store.indexSession({ agentId: "root", sessionFile, entries: sm.getEntries() });

		const results = await store.search({ query: "审批通知", limit: 5, scopeAgentIds: ["root"] });
		expect(results).toHaveLength(2);
		expect(results[0]?.agentId).toBe("root");
		expect(results.some((result) => result.text.includes("审批通知"))).toBe(true);

		const listed = await store.list({ memoryIds: [results[0]!.memoryId], contextBefore: 1, contextAfter: 1 });
		expect(listed).toHaveLength(1);
		expect(listed[0]?.items.map((item) => item.text).join("\n")).toContain("飞书消息中心");
	});

	it("uses the real jieba dictionary so Chinese subphrases are searchable", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-memory-store-jieba-"));
		tempDirs.push(cwd);
		const paths = initializeWorkspace(cwd).paths;
		const sessionFile = paths.sessionFile;
		const sm = SessionManager.open(sessionFile, paths.workspaceDir, cwd);
		sm.appendMessage({
			role: "user",
			content: "请记录南京市长江大桥的夜间通行提醒",
			timestamp: Date.now(),
		});
		const store = MemoryStore.open(cwd);

		await store.indexSession({ agentId: "root", sessionFile, entries: sm.getEntries() });

		const results = await store.search({ query: "长江大桥", limit: 5, scopeAgentIds: ["root"] });
		expect(results).toHaveLength(1);
		expect(results[0]?.text).toContain("南京市长江大桥");
	});

	it("persists indexed memories into the real libsql database and FTS table", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-memory-store-sqlite-"));
		tempDirs.push(cwd);
		const paths = initializeWorkspace(cwd).paths;
		const sessionFile = paths.sessionFile;
		const sm = SessionManager.open(sessionFile, paths.workspaceDir, cwd);
		sm.appendMessage({
			role: "user",
			content: "sqlite persistence marker for memory index",
			timestamp: Date.now(),
		});
		const store = MemoryStore.open(cwd);
		const dbFile = getMemoryDbFile(cwd);

		await store.indexSession({ agentId: "root", sessionFile, entries: sm.getEntries() });
		store.close();

		expect(existsSync(dbFile)).toBe(true);
		const sqlite = createClient({ url: `file:${dbFile}` });
		try {
			expect((await sqlite.execute("SELECT COUNT(*) AS count FROM memory_items")).rows[0]).toMatchObject({
				count: 1,
			});
			expect(
				(
					await sqlite.execute({
						sql: "SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH ?",
						args: ['"persistence"'],
					})
				).rows[0],
			).toMatchObject({ count: 1 });
		} finally {
			sqlite.close();
		}
	});

	it("can omit tool result memory from search results", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-memory-store-tools-"));
		tempDirs.push(cwd);
		const paths = initializeWorkspace(cwd).paths;
		const sessionFile = paths.sessionFile;
		const sm = SessionManager.open(sessionFile, paths.workspaceDir, cwd);
		sm.appendMessage({ role: "user", content: "普通消息", timestamp: Date.now() });
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "secret_tool",
			content: [{ type: "text", text: "工具输出应该可以被过滤" }],
			isError: false,
			timestamp: Date.now() + 1,
		});
		const store = MemoryStore.open(cwd);
		await store.indexSession({ agentId: "root", sessionFile, entries: sm.getEntries() });

		await expect(store.search({ query: "工具输出", includeToolResults: true })).resolves.toHaveLength(1);
		await expect(store.search({ query: "工具输出", includeToolResults: false })).resolves.toHaveLength(0);
	});
});
