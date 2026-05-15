import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CustomEntry, SessionEntry } from "@sheason/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionFile } from "../../src/hub/config.js";
import { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import { HUB_RUN_TIMING_CUSTOM_TYPE } from "../../src/hub/session/session-snapshot.js";
import { getAgentSessionFile, initializeWorkspace, WorkspaceNotInitializedError } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

function headerLine(id: string, cwd: string): string {
	return JSON.stringify({
		type: "session" as const,
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("HubSessionService.openAgent and getAgentSessionFile", () => {
	it("getAgentSessionFile returns .pi-hub/agents/<agent-id>.jsonl under cwd", () => {
		const cwd = "/tmp/proj";
		expect(getAgentSessionFile(cwd, "worker-1")).toBe(join(cwd, ".pi-hub", "agents", "worker-1.jsonl"));
	});

	it("getAgentSessionFile accepts id main", () => {
		const cwd = "/tmp/pi-main";
		expect(getAgentSessionFile(cwd, "main")).toBe(join(cwd, ".pi-hub", "agents", "main.jsonl"));
	});

	it("getAgentSessionFile accepts kebab-case id child-a", () => {
		const cwd = "/tmp/pi-child";
		expect(getAgentSessionFile(cwd, "child-a")).toBe(join(cwd, ".pi-hub", "agents", "child-a.jsonl"));
	});

	it("getAgentSessionFile rejects path-escape and invalid agent ids with explanatory message", () => {
		const cwd = "/tmp/proj";
		for (const id of ["../evil", "child/evil", "child\\evil", ""]) {
			expect(() => getAgentSessionFile(cwd, id)).toThrow(
				'Invalid agent id: expected "root" or lowercase kebab-case id.',
			);
		}
	});

	it("getAgentSessionFile rejects uppercase Child-A", () => {
		expect(() => getAgentSessionFile("/tmp/proj", "Child-A")).toThrow(
			'Invalid agent id: expected "root" or lowercase kebab-case id.',
		);
	});

	it("HubSessionService.openAgent opens an explicit session file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-open-agent-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "a1");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-a1", cwd)}\n`, "utf8");

		const svc = HubSessionService.openAgent(cwd, agentPath);
		expect(svc.getSnapshot().sessionFile).toBe(agentPath);
		expect(svc.getHeader().id).toBe("sess-a1");
	});

	it("two openAgent services for two files keep independent header and entries", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-open-agent-2-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const f1 = getAgentSessionFile(cwd, "x");
		const f2 = getAgentSessionFile(cwd, "y");
		writeFileSync(
			f1,
			`${headerLine("h1", cwd)}\n` +
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2025-01-02T00:00:00.000Z","message":{"role":"user","content":"a","timestamp":1}}\n',
			"utf8",
		);
		writeFileSync(f2, `${headerLine("h2", cwd)}\n`, "utf8");

		const a = HubSessionService.openAgent(cwd, f1);
		const b = HubSessionService.openAgent(cwd, f2);
		expect(a.getHeader().id).toBe("h1");
		expect(b.getHeader().id).toBe("h2");
		expect(a.getEntries().filter((e) => e.type === "message")).toHaveLength(1);
		expect(b.getEntries().filter((e) => e.type === "message")).toHaveLength(0);
	});

	it("default HubSessionService.open(cwd) still uses the main workspace session file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-open-main-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const mainPath = getSessionFile(cwd);
		const svc = HubSessionService.open(cwd);
		expect(svc.getSnapshot().sessionFile).toBe(mainPath);
		expect(existsSync(mainPath)).toBe(true);
	});

	it("openAgent throws when workspace is not initialized", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-not-init-"));
		tempDirs.push(cwd);
		const agentPath = getAgentSessionFile(cwd, "orphan");
		expect(() => HubSessionService.openAgent(cwd, agentPath)).toThrow(WorkspaceNotInitializedError);
	});

	it("records completed run timing as a session entry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-run-timing-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "timer");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("timer-session", cwd)}\n`, "utf8");
		let now = 1_700_000_000_000;
		const svc = HubSessionService.openAgent(cwd, agentPath, { now: () => now });

		svc.setRunState(true);
		expect(svc.getSnapshot()).toMatchObject({
			isRunning: true,
			runStartedAt: new Date(1_700_000_000_000).toISOString(),
			lastRunStartedAt: new Date(1_700_000_000_000).toISOString(),
		});

		now += 37_000;
		svc.setRunState(false, "completed");
		expect(svc.getSnapshot()).toMatchObject({
			isRunning: false,
			runStartedAt: undefined,
			lastRunStartedAt: new Date(1_700_000_000_000).toISOString(),
			lastRunEndedAt: new Date(1_700_000_037_000).toISOString(),
			lastRunDurationMs: 37_000,
			lastRunEndReason: "completed",
		});

		const timingEntry = svc.getSnapshot().entries.find(isRunTimingEntry);
		expect(timingEntry?.data).toMatchObject({ durationMs: 37_000 });
	});

	it("persists the current agent summary in the session file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agent-summary-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "summary-agent");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("summary-session", cwd)}\n`, "utf8");
		const svc = HubSessionService.openAgent(cwd, agentPath);

		svc.updateSummary("Reviewing the websocket reconnect bug");

		expect(svc.getSnapshot().summary).toBe("Reviewing the websocket reconnect bug");
		const summaryEntry = svc
			.getSnapshot()
			.entries.find(
				(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "agent_summary",
			);
		expect(summaryEntry?.data).toEqual({ summary: "Reviewing the websocket reconnect bug" });

		const reopened = HubSessionService.openAgent(cwd, agentPath);
		expect(reopened.getSnapshot().summary).toBe("Reviewing the websocket reconnect bug");
	});

	it("records interrupted run timing without overwriting idle duration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-run-interrupted-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "interrupt");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("interrupt-session", cwd)}\n`, "utf8");
		let now = 1_700_000_100_000;
		const svc = HubSessionService.openAgent(cwd, agentPath, { now: () => now });

		svc.setRunState(true);
		now += 12_000;
		svc.setRunState(false, "interrupted");
		const interruptedSnapshot = svc.getSnapshot();
		expect(interruptedSnapshot.lastRunDurationMs).toBe(12_000);
		expect(interruptedSnapshot.lastRunEndReason).toBe("interrupted");

		now += 12_000;
		svc.setRunState(false);
		expect(svc.getSnapshot().lastRunDurationMs).toBe(12_000);
		expect(svc.getSnapshot().lastRunEndReason).toBe("interrupted");
	});

	it("can record a recoverable error without ending the active run", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-recoverable-error-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "recoverable");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("recoverable-session", cwd)}\n`, "utf8");
		let now = 1_700_000_000_000;
		const svc = HubSessionService.openAgent(cwd, agentPath, { now: () => now });

		svc.setRunState(true);
		now += 5_000;
		svc.recordError("tool validation failed", { endRun: false });

		const snapshot = svc.getSnapshot();
		expect(snapshot.isRunning).toBe(true);
		expect(snapshot.runStartedAt).toBe(new Date(1_700_000_000_000).toISOString());
		expect(snapshot.lastRunDurationMs).toBeUndefined();
		expect(snapshot.lastRunEndReason).toBeUndefined();
		expect(snapshot.lastError).toBe("tool validation failed");
	});

	it("fills runStartedAt when sync observes streaming before agent_start", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-run-start-sync-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "sync-start");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sync-start-session", cwd)}\n`, "utf8");
		const startedAtMs = 1_700_000_300_000;
		const svc = HubSessionService.openAgent(cwd, agentPath, { now: () => startedAtMs });
		const session = {
			isStreaming: true,
			messages: [],
			thinkingLevel: "off",
			model: null,
			state: { pendingToolCalls: [] },
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			getContextUsage: () => undefined,
		} as unknown as AgentSession;

		svc.bindAgentSession(session);
		expect(svc.getSnapshot().isRunning).toBe(true);
		expect(svc.getSnapshot().runStartedAt).toBeUndefined();

		svc.setRunState(true);

		expect(svc.getSnapshot()).toMatchObject({
			isRunning: true,
			runStartedAt: new Date(startedAtMs).toISOString(),
			lastRunStartedAt: new Date(startedAtMs).toISOString(),
		});
	});

	it("persists run timing history as session entries", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-run-history-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "history");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("history-session", cwd)}\n`, "utf8");
		let now = 1_700_000_200_000;
		const svc = HubSessionService.openAgent(cwd, agentPath, { now: () => now });

		svc.setRunState(true);
		now += 2_000;
		svc.setRunState(false, "completed");
		now += 3_000;
		svc.setRunState(true);
		now += 4_000;
		svc.setRunState(false, "interrupted");

		const timings = svc
			.getSnapshot()
			.entries.filter(isRunTimingEntry)
			.map((entry) => entry.data);
		expect(timings).toEqual([
			{
				startedAt: new Date(1_700_000_200_000).toISOString(),
				endedAt: new Date(1_700_000_202_000).toISOString(),
				durationMs: 2_000,
				endReason: "completed",
			},
			{
				startedAt: new Date(1_700_000_205_000).toISOString(),
				endedAt: new Date(1_700_000_209_000).toISOString(),
				durationMs: 4_000,
				endReason: "interrupted",
			},
		]);

		expect(svc.getSnapshot().lastRunDurationMs).toBe(4_000);
		expect(svc.getSnapshot().lastRunEndReason).toBe("interrupted");
	});
});

function isRunTimingEntry(entry: SessionEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === HUB_RUN_TIMING_CUSTOM_TYPE;
}
