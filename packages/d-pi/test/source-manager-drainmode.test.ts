import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DrainMode, SourceManager } from "../src/hub/source-manager.ts";

/**
 * Unit + integration coverage for the per-event drainMode field.
 *
 * drainMode ("all" | "one-at-a-time") is the 5th arg to the SourceManager
 * broadcast callback, parsed from JSONRPC `params.drainMode` and
 * coerced (invalid → "all"). It mirrors the upstream coding-agent
 * PendingMessageQueue.mode enum.
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
	deliverAs: "steer" | "followUp" | "prompt";
	drainMode: DrainMode;
}

const CREATOR = "drainmode-creator";

const FAST_BACKOFF = {
	initialRestartDelayMs: 100,
	maxRestartDelayMs: 300,
	maxRestartAttempts: 3,
};

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

function makeManager() {
	const broadcasts: BroadcastCall[] = [];
	const manager = new SourceManager((sourceName, line, subscriberAgentIds, deliverAs, drainMode) => {
		broadcasts.push({ sourceName, line, subscriberAgentIds, deliverAs, drainMode });
	}, FAST_BACKOFF);
	return { manager, broadcasts };
}

function emit(params: Record<string, unknown>): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		method: "events.emit",
		params,
	});
}

describe("SourceManager drainMode coercion", () => {
	let manager: SourceManager;
	let broadcasts: BroadcastCall[];

	beforeEach(() => {
		const ctx = makeManager();
		manager = ctx.manager;
		broadcasts = ctx.broadcasts;
	});

	afterEach(async () => {
		try {
			manager.stopAll();
		} catch {
			// ignore
		}
		await wait(50);
	});

	it('forwards drainMode="all" verbatim', async () => {
		const line = emit({ type: "test", id: "ev1", drainMode: "all" });
		manager.createSource({ name: "all-mode", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "all-mode"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "all-mode");
		expect(b?.drainMode).toBe("all");
	});

	it('forwards drainMode="one-at-a-time" verbatim', async () => {
		const line = emit({ type: "test", id: "ev2", drainMode: "one-at-a-time" });
		manager.createSource({ name: "oat-mode", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "oat-mode"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "oat-mode");
		expect(b?.drainMode).toBe("one-at-a-time");
	});

	it('coerces invalid drainMode to "all" (defensive default)', async () => {
		// Wrong case, wrong separator, number, boolean — all coerce to "all"
		const cases = ["ALL", "one_at_a_time", 42, true];
		const lines = cases.map((raw, i) => emit({ type: "test", id: `d${i}`, drainMode: raw }));
		const script = lines.map((l) => `echo '${l}'`).join("\n");
		manager.createSource({ name: "bad-drainMode", command: "sh", args: ["-c", script] }, CREATOR);

		await waitFor(() => broadcasts.filter((b) => b.sourceName === "bad-drainMode").length >= 4, 3_000, 20);
		const bs = broadcasts.filter((b) => b.sourceName === "bad-drainMode");
		expect(bs.length).toBeGreaterThanOrEqual(4);
		for (const b of bs) {
			expect(b.drainMode).toBe("all");
		}
	});

	it('defaults drainMode to "all" when source omits the field', async () => {
		const line = emit({ type: "test", id: "ev3" });
		manager.createSource({ name: "no-drainMode", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "no-drainMode"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "no-drainMode");
		expect(b?.drainMode).toBe("all");
	});

	it("forwards both deliverAs and drainMode when source declares both", async () => {
		const line = emit({
			type: "test",
			id: "ev4",
			deliverAs: "steer",
			drainMode: "one-at-a-time",
		});
		manager.createSource({ name: "both-fields", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "both-fields"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "both-fields");
		expect(b?.deliverAs).toBe("steer");
		expect(b?.drainMode).toBe("one-at-a-time");
	});

	it('works in combination: deliverAs="followUp" + drainMode="one-at-a-time"', async () => {
		const line = emit({
			type: "test",
			id: "ev5",
			deliverAs: "followUp",
			drainMode: "one-at-a-time",
		});
		manager.createSource({ name: "combo", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "combo"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "combo");
		expect(b?.deliverAs).toBe("followUp");
		expect(b?.drainMode).toBe("one-at-a-time");
	});

	it('supervisor-error broadcasts always use drainMode="all" regardless of source content', async () => {
		// Source emits a notification with drainMode:"one-at-a-time" then
		// exits. Supervisor-error should NOT inherit — operational infra.
		const line = emit({ type: "test", id: "ev-err", drainMode: "one-at-a-time" });
		manager.createSource({ name: "exit-after", command: "sh", args: ["-c", `echo '${line}'\nexit 0`] }, CREATOR);

		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "exit-after" && b.line.startsWith("[source-error]")),
			3_000,
			20,
		);
		const errorBroadcasts = broadcasts.filter(
			(b) => b.sourceName === "exit-after" && b.line.startsWith("[source-error]"),
		);
		expect(errorBroadcasts.length).toBeGreaterThanOrEqual(1);
		for (const b of errorBroadcasts) {
			expect(b.deliverAs).toBe("followUp");
			expect(b.drainMode).toBe("all");
		}
	});
});
