import { describe, expect, it } from "vitest";
import type { HubLogEntry } from "../../src/hub/tui/hub-log.js";
import { type HubTuiViewModel, renderHubTuiLines } from "../../src/hub/tui/hub-tui-view.js";

describe("renderHubTuiLines", () => {
	it("renders a status page without logs by default", () => {
		const logs: HubLogEntry[] = [
			{ timestamp: Date.UTC(2026, 3, 26, 3, 4, 5), level: "info", message: "hub 已启动" },
			{
				timestamp: Date.UTC(2026, 3, 26, 3, 5, 6),
				level: "warning",
				message: "source exited",
				details: { sourceName: "timer", code: 0 },
			},
		];
		const view: HubTuiViewModel = {
			status: "running",
			address: "http://127.0.0.1:4317",
			workspace: "/tmp/workspace",
			rootToken: "dpi_root_test_token",
			protocolVersion: 2,
			agents: [
				{
					id: "root",
					kind: "root",
					isRunning: true,
					peerCount: 1,
					sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
					lastRunDurationMs: 102_000,
				},
				{
					id: "child",
					name: "Obsidian 维护助手",
					description: "维护 Obsidian vault 与资料同步",
					kind: "child",
					isRunning: false,
					peerCount: 0,
					sessionFile: "/tmp/workspace/.child-agent/child/session.jsonl",
					lastRunDurationMs: 38_000,
					lastError: "source failed",
				},
			],
			resources: {
				mcpServers: 2,
				mcpStatusCounts: { starting: 0, running: 1, stopped: 0, error: 1 },
				sources: 1,
				sourceStatusCounts: { starting: 0, running: 1, stopped: 0, error: 0 },
				skills: 63,
				prompts: 0,
				themes: 0,
			},
			logs,
		};

		const lines = renderHubTuiLines(view, 120);
		const text = lines.join("\n");

		expect(text).toContain("pi-hub 运行中");
		expect(text).toContain("http://127.0.0.1:4317");
		expect(text).toContain("workspace  /tmp/workspace");
		expect(text).toContain("Access");
		expect(text).toContain("Root token  dpi_root_test_token");
		expect(text).toContain("protocol 2");
		expect(text).toContain("Agents  2 total  1 running  1 idle");
		expect(text).toContain("root");
		expect(text).toContain("运行中");
		expect(text).toContain("child");
		expect(text).toContain("Obsidian 维护助手");
		expect(text).toContain("维护 Obsidian vault 与资料同步");
		expect(text).toContain("空闲");
		expect(text).toContain("session .pi-hub/session.jsonl");
		expect(text).toContain("last 01:42");
		expect(text).toContain("session .child-agent/child/session.jsonl");
		expect(text).toContain("last 00:38");
		expect(text).toContain("source failed");
		expect(text).toContain("Resources");
		expect(text).toContain("MCP      2 total  1 running  1 error");
		expect(text).toContain("Sources  1 total  1 running");
		expect(text).toContain("Skills   63");
		expect(text).toContain("Recent Events");
		expect(text).toContain("警告 Source 已退出");
		expect(text).toContain("Source=timer");
		expect(text).toContain("l 日志");
		expect(text).toContain("q 退出");
		expect(text).not.toContain("hub 已启动");
		expect(text).not.toContain("r 刷新");
	});

	it("renders logs on the log page and clips old lines first when height is constrained", () => {
		const view: HubTuiViewModel = {
			status: "running",
			address: "http://127.0.0.1:4317",
			workspace: "/tmp/workspace",
			protocolVersion: 3,
			agents: [],
			resources: { mcpServers: 3, sources: 1, skills: 12, prompts: 8, themes: 2 },
			logs: [
				{ timestamp: Date.UTC(2026, 3, 26, 3, 0, 0), level: "info", message: "old" },
				{ timestamp: Date.UTC(2026, 3, 26, 3, 1, 0), level: "info", message: "middle" },
				{ timestamp: Date.UTC(2026, 3, 26, 3, 2, 0), level: "info", message: "new" },
			],
		};

		const lines = renderHubTuiLines(view, 120, 7, { mode: "logs" });
		const text = lines.join("\n");

		expect(lines).toHaveLength(7);
		expect(text).not.toContain("信息 old");
		expect(text).toContain("信息 middle");
		expect(text).toContain("信息 new");
		expect(text).toContain("日志");
		expect(text).toContain("q 返回");
		expect(text).toContain("pi-hub 运行中");
	});

	it("renders older logs when scrolled away from the bottom", () => {
		const view: HubTuiViewModel = {
			status: "running",
			address: "http://127.0.0.1:4317",
			workspace: "/tmp/workspace",
			protocolVersion: 3,
			agents: [],
			resources: { mcpServers: 3, sources: 1, skills: 12, prompts: 8, themes: 2 },
			logs: [
				{ timestamp: Date.UTC(2026, 3, 26, 3, 0, 0), level: "info", message: "old" },
				{ timestamp: Date.UTC(2026, 3, 26, 3, 1, 0), level: "info", message: "middle" },
				{ timestamp: Date.UTC(2026, 3, 26, 3, 2, 0), level: "info", message: "new" },
			],
		};

		const lines = renderHubTuiLines(view, 120, 7, { mode: "logs", logScrollOffsetFromBottom: 1 });
		const text = lines.join("\n");

		expect(text).toContain("信息 old");
		expect(text).toContain("信息 middle");
		expect(text).not.toContain("信息 new");
		expect(text).toContain("pi-hub 运行中");
	});

	it("renders multiline colored log details for the TUI log page", () => {
		const view: HubTuiViewModel = {
			status: "running",
			address: "http://127.0.0.1:4317",
			workspace: "/tmp/workspace",
			protocolVersion: 3,
			agents: [],
			resources: { mcpServers: 0, sources: 0, skills: 0, prompts: 0, themes: 0 },
			logs: [
				{
					timestamp: Date.UTC(2026, 3, 26, 3, 5, 6),
					level: "error",
					message: "tool timing",
					details: { agentId: "main", toolName: "write", durationMs: 42, isError: true },
				},
			],
		};

		const text = renderHubTuiLines(view, 120, undefined, { mode: "logs", color: true }).join("\n");

		expect(text).toContain("\u001b[31m错误\u001b[0m");
		expect(text).toContain("工具调用耗时");
		expect(text).toContain("\n  智能体=main");
		expect(text).toContain("工具=write");
		expect(text).toContain("耗时=42ms");
	});
});
