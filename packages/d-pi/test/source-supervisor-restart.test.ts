import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";

/**
 * Regression coverage for the SourceManager supervisor:
 *
 * Bug: `d-pi create-source` started long-running child processes (most
 * importantly `lark-cli event consume ...`) and treated any exit with
 * `code === 0` as a normal completion — leaving the source in `stopped`
 * and never restarting it. Long-running consumers exit cleanly (code 0)
 * whenever the internal bus daemon goes idle, the WebSocket drops, or
 * stdin is closed, so the source's inbound channel was silently lost
 * for hours on end. See sheason2019/pi-mono#2.
 *
 * Fix: any non-destroyed exit (code 0, non-zero, or signal) is now
 * treated as a supervisor-level failure and scheduled for restart with
 * exponential backoff, with a hard cap on consecutive attempts before
 * the source is marked `failed`.
 *
 * To keep this regression suite well under the bash tool's 30s default
 * timeout, the supervisor is constructed with a short backoff (200ms
 * initial, 500ms cap) and a low attempt cap (3) for the "exhausted"
 * case. The PRODUCTION defaults live as constants in source-manager.ts
 * and are exercised by reading the source — the regression we care
 * about is the supervisor's *behavior*, not the exact delays.
 *
 * The supervisor spawns its child through `shell: true` and joins args
 * with a single space, so commands must be shell-safe (no unescaped
 * metacharacters). For the "exits with code 0 after a delay" case we
 * use `sleep 0.2; exit 0`; for the immediate-exit and explicit-code
 * cases we write small scripts to a temp dir.
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
		}
		await wait(intervalMs);
	}
}

function makeManager(opts?: {
	initialRestartDelayMs?: number;
	maxRestartDelayMs?: number;
	maxRestartAttempts?: number;
}) {
	const broadcasts: BroadcastCall[] = [];
	const manager = new SourceManager((sourceName, line, subscriberAgentIds) => {
		broadcasts.push({ sourceName, line, subscriberAgentIds });
	}, opts);
	return { manager, broadcasts };
}

describe("SourceManager supervisor (regression for sheason2019/pi-mono#2)", () => {
	let manager: SourceManager;
	let broadcasts: BroadcastCall[];
	let tempDir: string;
	const CREATOR = "creator-agent-1";

	// All tests use a short backoff so the full backoff curve is exercised
	// in well under a second. `maxRestartAttempts` is set to 3 (one less
	// than the production default of 5) so the "exhausted" path completes
	// in a handful of cycles.
	const FAST_BACKOFF = {
		initialRestartDelayMs: 100,
		maxRestartDelayMs: 300,
		maxRestartAttempts: 3,
	};

	beforeEach(() => {
		const ctx = makeManager(FAST_BACKOFF);
		manager = ctx.manager;
		broadcasts = ctx.broadcasts;
		tempDir = mkdtempSync(join(tmpdir(), "d-pi-source-supervisor-"));
	});

	afterEach(async () => {
		// Always stop all child processes left running between tests
		try {
			manager.stopAll();
		} catch {
			// ignore
		}
		// Small grace period to let the SIGTERM/SIGKILL chain settle so the
		// vitest process doesn't get a zombie reaped mid-suite
		await wait(50);
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Write a small shell script to a temp file so the source manager can
	 * invoke it as a single shell-safe command argument. The supervisor
	 * spawns its child through `shell: true` and joins args with a space,
	 * which breaks any arg containing whitespace, so we cannot pass a
	 * `sh -c "exit 7"` style script directly.
	 */
	function writeScript(name: string, body: string): string {
		const path = join(tempDir, name);
		writeFileSync(path, body, { mode: 0o755 });
		return path;
	}

	it("restarts a source whose child exits with code 0 (was: silently abandoned)", async () => {
		// Shell-native command: sleep 200ms then exit 0. Before the fix this
		// was treated as "normal completion" and the source would have
		// stayed in `stopped` forever.
		manager.createSource(
			{
				name: "code0-source",
				command: "sh",
				args: ["-c", "sleep 0.2; exit 0"],
			},
			CREATOR,
		);

		// Initial restartCount must be 0 (nothing has died yet)
		const initial = manager.getSourceStats("code0-source");
		expect(initial?.status).toBe("running");
		expect(initial?.restartCount).toBe(0);

		// Wait until the supervisor has scheduled a restart (restartCount
		// is incremented synchronously in _scheduleRestart when the
		// backoff timer is armed — that happens immediately after the
		// child exits, well before the timer actually fires).
		await waitFor(() => (manager.getSourceStats("code0-source")?.restartCount ?? 0) > 0, 3_000, 20);

		// The supervisor must have notified the creator that the source
		// exited. The exit broadcast goes through the same `_onBroadcast`
		// channel with a `[source-error]` prefix.
		const exitBroadcasts = broadcasts.filter(
			(b) => b.sourceName === "code0-source" && b.line.startsWith("[source-error]"),
		);
		expect(exitBroadcasts.length).toBeGreaterThanOrEqual(1);
		expect(exitBroadcasts[0]?.subscriberAgentIds).toEqual([CREATOR]);
		expect(exitBroadcasts[0]?.line).toMatch(/code=0/);
	});

	it("does not restart a source after destroySource is called", async () => {
		manager.createSource(
			{
				name: "destroyable-source",
				command: "sh",
				args: ["-c", "sleep 0.2; exit 0"],
			},
			CREATOR,
		);

		// Wait until the supervisor has scheduled a restart
		await waitFor(() => (manager.getSourceStats("destroyable-source")?.restartCount ?? 0) > 0, 3_000, 20);

		const restartCountAtDestroy = manager.getSourceStats("destroyable-source")?.restartCount ?? 0;

		// destroySource refuses to act while there are still subscribers
		// (the creator is auto-subscribed on createSource). Unsubscribe
		// first, then destroy.
		manager.unsubscribe("destroyable-source", CREATOR);
		manager.destroySource("destroyable-source");

		const broadcastsAtDestroy = broadcasts.filter(
			(b) => b.sourceName === "destroyable-source" && b.line.startsWith("[source-error]"),
		).length;

		// Wait long enough that, if destroy had been ignored, another
		// restart would have happened (300ms cap + grace)
		await wait(1_000);

		const exitBroadcastsAfterDestroy = broadcasts.filter(
			(b) => b.sourceName === "destroyable-source" && b.line.startsWith("[source-error]"),
		).length;

		expect(exitBroadcastsAfterDestroy).toBe(broadcastsAtDestroy);
		// The source is no longer registered
		expect(manager.getSourceStats("destroyable-source")).toBeUndefined();
		// Sanity: the recorded restartCount at destroy time is captured for
		// debugging in case the assertion above ever fails
		expect(restartCountAtDestroy).toBeGreaterThanOrEqual(1);
	});

	it("marks the source as 'failed' after maxRestartAttempts consecutive crashes", async () => {
		// Command that exits immediately with code 0. With the old code,
		// this would never have been restarted at all. With the new code,
		// it should keep getting respawned until the attempt budget runs
		// out and the source is flagged `failed`.
		manager.createSource(
			{
				name: "doomed-source",
				command: "sh",
				args: ["-c", "exit 0"],
			},
			CREATOR,
		);

		// 3 attempts × ~200ms backoff = ~600ms. Give it 3s of head-room.
		await waitFor(() => manager.getSourceStats("doomed-source")?.status === "failed", 3_000, 20);

		const finalStats = manager.getSourceStats("doomed-source");
		expect(finalStats?.status).toBe("failed");
		expect(finalStats?.restartCount).toBeGreaterThanOrEqual(3);

		// Verify a "giving up" notification was broadcast
		const failedBroadcasts = broadcasts.filter(
			(b) => b.sourceName === "doomed-source" && b.line.includes("failed after"),
		);
		expect(failedBroadcasts.length).toBeGreaterThanOrEqual(1);
		expect(failedBroadcasts[0]?.subscriberAgentIds).toEqual([CREATOR]);
	});

	it("notifies the creator with the actual exit code (non-zero path)", async () => {
		// Exercise the non-zero exit path so we know the code/signal pair
		// is always propagated verbatim to the creator broadcast.
		//
		// We use a small script on disk because the supervisor joins args
		// with a single space and runs under `sh -c`, so we can't safely
		// pass a multi-word `sh -c "exit 7"` inline (the inner space
		// would split the script into two tokens).
		const script = writeScript("exit-7.sh", "exit 7\n");
		manager.createSource(
			{
				name: "crash-source",
				command: "sh",
				args: [script],
			},
			CREATOR,
		);

		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "crash-source" && b.line.startsWith("[source-error]")),
			3_000,
			20,
		);

		const firstExit = broadcasts.find((b) => b.sourceName === "crash-source" && b.line.startsWith("[source-error]"));
		expect(firstExit).toBeDefined();
		expect(firstExit?.line).toMatch(/code=7/);
		expect(firstExit?.subscriberAgentIds).toEqual([CREATOR]);
	});
});
