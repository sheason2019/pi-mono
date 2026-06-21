import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DPiSessionStore } from "../src/runtime/session-store.ts";
import {
	createDPiTranscriptBoundaryEntry,
	createDPiTranscriptNoticeEntry,
	createDPiTranscriptSteeringQueueEntry,
	createDPiTranscriptToolStateEntry,
	createDPiTranscriptTurnStatsEntry,
	DPiTranscriptCustomTypes,
	projectDPiTranscript,
} from "../src/runtime/transcript/projector.ts";

let tempDir: string | undefined;

function createTempWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-transcript-"));
	mkdirSync(join(tempDir, "agent"), { recursive: true });
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("d-pi session transcript projector", () => {
	it("restores the current compact page from d-pi transcript boundary custom entries", async () => {
		const workspaceRoot = createTempWorkspace();
		const store = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});
		const session = await store.create({ id: "transcript-session" });
		const beforeId = await session.session.appendMessage({ role: "user", content: "before compact", timestamp: 1 });
		await session.session.appendCompaction("Persistent compact summary", beforeId, 12345);
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.boundary,
			createDPiTranscriptBoundaryEntry({
				reason: "compact",
				label: "Compact completed 9s",
				summary: "Persistent compact summary",
				tokensBefore: 12345,
				durationMs: 9000,
				completedAt: 10,
			}),
		);
		await session.session.appendMessage({ role: "user", content: "after compact", timestamp: 11 });

		const reopened = await store.open("transcript-session");
		const branch = await reopened.session.getBranch();
		const transcript = projectDPiTranscript(branch);
		const providerContext = await reopened.session.buildContext();

		expect(transcript.page.reason).toBe("compact");
		expect(transcript.messages).toEqual([
			expect.objectContaining({
				role: "custom",
				customType: "compact-divider",
				content: "Compact completed 9s",
				details: expect.objectContaining({
					summary: "Persistent compact summary",
					tokensBefore: 12345,
					durationMs: 9000,
				}),
			}),
			expect.objectContaining({ role: "user", content: "after compact" }),
		]);
		expect(JSON.stringify(transcript.messages)).not.toContain("before compact");
		expect(JSON.stringify(providerContext.messages)).not.toContain("Compact completed 9s");
		expect(JSON.stringify(providerContext.messages)).not.toContain(DPiTranscriptCustomTypes.boundary);
	});

	it("projects persisted transcript items without polluting the provider context", async () => {
		const workspaceRoot = createTempWorkspace();
		const store = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});
		const session = await store.create({ id: "transcript-items-session" });
		await session.session.appendMessage({ role: "user", content: "run ls", timestamp: 1 });
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.toolState,
			createDPiTranscriptToolStateEntry({
				toolCallId: "tool-1",
				toolName: "ls",
				status: "running",
				args: { path: "." },
				timestamp: 2,
			}),
		);
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.toolState,
			createDPiTranscriptToolStateEntry({
				toolCallId: "tool-1",
				toolName: "ls",
				status: "succeeded",
				result: { content: [{ type: "text", text: "agent.ts" }] },
				timestamp: 3,
			}),
		);
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.turnStats,
			createDPiTranscriptTurnStatsEntry({
				tps: 12.3,
				output: 4,
				input: 10,
				cacheRead: 5,
				cacheWrite: 0,
				total: 19,
				duration: 0.4,
				timestamp: 4,
			}),
		);
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.notice,
			createDPiTranscriptNoticeEntry({
				level: "error",
				text: "Runtime failed",
				timestamp: 5,
			}),
		);

		const reopened = await store.open("transcript-items-session");
		const transcript = projectDPiTranscript(await reopened.session.getBranch());
		const providerContext = await reopened.session.buildContext();

		expect(transcript.items).toEqual([
			expect.objectContaining({ type: "message", message: expect.objectContaining({ content: "run ls" }) }),
			expect.objectContaining({ type: "tool_state", toolCallId: "tool-1", status: "running" }),
			expect.objectContaining({ type: "tool_state", toolCallId: "tool-1", status: "succeeded" }),
			expect.objectContaining({ type: "turn_stats", output: 4, total: 19 }),
			expect.objectContaining({ type: "notice", level: "error", text: "Runtime failed" }),
		]);
		expect(transcript.messages).toEqual([expect.objectContaining({ content: "run ls" })]);
		expect(JSON.stringify(providerContext.messages)).not.toContain("Runtime failed");
		expect(JSON.stringify(providerContext.messages)).not.toContain("agent.ts");
	});

	it("restores the latest persisted steering queue state without adding provider context", async () => {
		const workspaceRoot = createTempWorkspace();
		const store = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});
		const session = await store.create({ id: "steering-queue-session" });
		await session.session.appendMessage({ role: "user", content: "running prompt", timestamp: 1 });
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.steeringQueue,
			createDPiTranscriptSteeringQueueEntry({
				revision: 1,
				runId: "run-1",
				items: [
					{
						id: "steer-1",
						text: "first interrupt",
						createdAt: 2,
					},
				],
				timestamp: 2,
			}),
		);
		await session.session.appendCustomEntry(
			DPiTranscriptCustomTypes.steeringQueue,
			createDPiTranscriptSteeringQueueEntry({
				revision: 2,
				runId: "run-1",
				items: [
					{
						id: "steer-2",
						text: "latest interrupt",
						createdAt: 3,
					},
				],
				timestamp: 3,
			}),
		);

		const reopened = await store.open("steering-queue-session");
		const transcript = projectDPiTranscript(await reopened.session.getBranch());
		const providerContext = await reopened.session.buildContext();

		expect(transcript.steeringQueue).toEqual({
			version: 1,
			revision: 2,
			runId: "run-1",
			items: [expect.objectContaining({ id: "steer-2", text: "latest interrupt", createdAt: 3 })],
			timestamp: 3,
		});
		expect(transcript.messages).toEqual([expect.objectContaining({ content: "running prompt" })]);
		expect(JSON.stringify(providerContext.messages)).not.toContain("latest interrupt");
		expect(JSON.stringify(providerContext.messages)).not.toContain(DPiTranscriptCustomTypes.steeringQueue);
	});
});
