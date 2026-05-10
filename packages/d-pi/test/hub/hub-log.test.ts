import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatHubLogEntry,
	getHubLogFile,
	getHubLogLegacyFile,
	HubLogBuffer,
	HubLogStore,
} from "../../src/hub/tui/hub-log.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("HubLogBuffer", () => {
	it("keeps structured log entries and caps the buffer", () => {
		let now = 1_700_000_000_000;
		const logs = new HubLogBuffer({ maxEntries: 2, now: () => now });

		logs.info("hub 启动中");
		now += 1000;
		logs.warning("source 异常", "foo failed");
		now += 1000;
		logs.error("mcp 启动失败");

		expect(logs.getEntries()).toEqual([
			{ timestamp: 1_700_000_001_000, level: "warning", message: "source 异常", details: "foo failed" },
			{ timestamp: 1_700_000_002_000, level: "error", message: "mcp 启动失败" },
		]);
	});

	it("formats Chinese level labels and HH:mm:ss timestamps", () => {
		const text = formatHubLogEntry({
			timestamp: Date.UTC(2026, 3, 26, 3, 4, 5),
			level: "info",
			message: "peer laptop 连接到 agent main",
		});

		expect(text).toContain("03:04:05");
		expect(text).toContain("信息");
		expect(text).toContain("peer laptop 连接到 agent main");
	});

	it("renders known English log messages and detail keys in Chinese for users", () => {
		const text = formatHubLogEntry({
			timestamp: Date.UTC(2026, 3, 26, 3, 4, 5),
			level: "info",
			message: "queue flush submitted",
			details: {
				agentId: "main",
				runId: "main-1",
				phase: "queue",
				drainMode: "flush",
				queuedMessages: 2,
				queueWaitMs: 123,
				abortDurationMs: 45,
				payloadBytes: 99,
			},
		});

		expect(text).toContain("队列 flush 提交");
		expect(text).toContain("智能体=main");
		expect(text).toContain("运行=main-1");
		expect(text).toContain("阶段=队列");
		expect(text).toContain("消费模式=flush");
		expect(text).toContain("队列消息数=2");
		expect(text).toContain("队列等待=123ms");
		expect(text).toContain("中断耗时=45ms");
		expect(text).toContain("载荷大小=99B");
	});

	it("persists and reloads hub logs as JSONL", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-log-"));
		tempDirs.push(cwd);
		const file = getHubLogFile(cwd);
		const store = HubLogStore.open(file, { maxEntries: 20, now: () => 1_700_000_000_000 });

		store.info("peer connected", { agentId: "main", peerId: "p1" });
		store.warning("source exited", { sourceName: "timer" });

		const raw = readFileSync(file, "utf8");
		expect(raw).toContain('"message":"peer connected"');
		expect(raw).toContain('"agentId":"main"');

		const reloaded = HubLogStore.open(file, { maxEntries: 20 });
		expect(reloaded.getEntries().map((entry) => entry.message)).toEqual(["peer connected", "source exited"]);
		expect(reloaded.getEntries().map((entry) => entry.timestamp)).toEqual([1_700_000_000_000, 1_700_000_000_000]);
		expect(reloaded.getEntries()[0]?.details).toEqual({ agentId: "main", peerId: "p1" });
	});

	it("writes workspace logs into daily slices and rolls over when the slice is too large", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-log-slice-"));
		tempDirs.push(cwd);
		const dayOne = Date.UTC(2026, 3, 26, 3, 4, 5);
		let now = dayOne;
		const store = HubLogStore.openWorkspace(cwd, {
			maxEntries: 20,
			maxFileBytes: 180,
			now: () => now,
		});

		store.info("first day", { agentId: "main", payloadBytes: 120 });
		store.info("first day rollover", { agentId: "main", payloadBytes: 120 });
		now = Date.UTC(2026, 3, 27, 1, 2, 3);
		store.info("second day", { agentId: "main" });

		const files = readdirSync(join(cwd, ".pi-hub", "logs")).sort();
		expect(files).toEqual(["2026-04-26.1.jsonl", "2026-04-26.jsonl", "2026-04-27.jsonl"]);
		expect(readFileSync(getHubLogFile(cwd, dayOne), "utf8")).toContain("first day");
		expect(readFileSync(getHubLogFile(cwd, now), "utf8")).toContain("second day");
	});

	it("loads only the latest workspace log entries and includes legacy history", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-log-recent-"));
		tempDirs.push(cwd);
		mkdirSync(dirname(getHubLogLegacyFile(cwd)), { recursive: true });
		writeFileSync(
			getHubLogLegacyFile(cwd),
			`${JSON.stringify({ timestamp: 1, level: "info", message: "legacy" })}\n`,
			"utf8",
		);
		mkdirSync(join(cwd, ".pi-hub", "logs"), { recursive: true });
		for (let i = 0; i < 600; i += 1) {
			appendFileSync(
				join(cwd, ".pi-hub", "logs", "2026-04-26.jsonl"),
				`${JSON.stringify({ timestamp: 1000 + i, level: "info", message: `entry-${i}` })}\n`,
				"utf8",
			);
		}

		const store = HubLogStore.openWorkspace(cwd, { maxEntries: 500, now: () => Date.UTC(2026, 3, 26) });
		const entries = store.getEntries();

		expect(entries).toHaveLength(500);
		expect(entries[0]?.message).toBe("entry-100");
		expect(entries.at(-1)?.message).toBe("entry-599");
	});

	it("loads latest entries and ignores malformed JSONL lines", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-log-"));
		tempDirs.push(cwd);
		const file = getHubLogFile(cwd);
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, "{not json}\n", "utf8");
		const store = HubLogStore.open(file, { maxEntries: 2, now: () => 1_700_000_000_000 });
		store.info("first");
		store.info("second");
		store.info("third");

		const reloaded = HubLogStore.open(file, { maxEntries: 2 });
		expect(reloaded.getEntries().map((entry) => entry.message)).toEqual(["second", "third"]);
	});
});
