import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";

/**
 * Unit + integration coverage for the deliverAs routing capability.
 *
 * Sources declare a per-event `params.deliverAs` in their JSONRPC
 * notification ("steer" | "followUp" | "prompt"). SourceManager
 * parses it from the validated notification and forwards it as a 4th
 * argument to the broadcast callback. Downstream (hub → worker →
 * extension) uses it to pick the matching `pi.sendMessage` option.
 *
 * These tests cover the SourceManager side: parsing, defaulting, and
 * unknown-value coercion. The end-to-end "steer actually interrupts"
 * test lives with the e2e harness.
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
	deliverAs: "steer" | "followUp" | "prompt";
}

const CREATOR = "deliveras-creator";

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
	const manager = new SourceManager((sourceName, line, subscriberAgentIds, deliverAs) => {
		broadcasts.push({ sourceName, line, subscriberAgentIds, deliverAs });
	}, FAST_BACKOFF);
	return { manager, broadcasts };
}

describe("SourceManager deliverAs routing", () => {
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

	function emitNotification(params: Record<string, unknown>): string {
		return JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params,
		});
	}

	it("defaults deliverAs to followUp when params.deliverAs is absent", async () => {
		const line = emitNotification({ type: "test.event", id: "ev1", data: {} });
		manager.createSource({ name: "no-deliveras", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "no-deliveras" && b.deliverAs === "followUp"),
			3_000,
			20,
		);
		const b = broadcasts.find((b) => b.sourceName === "no-deliveras");
		expect(b?.deliverAs).toBe("followUp");
	});

	it("routes deliverAs:steer to the steer broadcast", async () => {
		const line = emitNotification({ type: "test.urgent", id: "ev2", deliverAs: "steer", data: {} });
		manager.createSource({ name: "steer-src", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "steer-src" && b.deliverAs === "steer"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "steer-src");
		expect(b?.deliverAs).toBe("steer");
		expect(b?.line).toContain('"deliverAs":"steer"');
	});

	it("routes deliverAs:prompt to the prompt broadcast", async () => {
		const line = emitNotification({ type: "test.prompt", id: "ev3", deliverAs: "prompt", data: {} });
		manager.createSource({ name: "prompt-src", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "prompt-src" && b.deliverAs === "prompt"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "prompt-src");
		expect(b?.deliverAs).toBe("prompt");
	});

	it("coerces unknown deliverAs values to followUp (defensive default)", async () => {
		// Lowercase, numeric, missing string — all should default to followUp
		// so a misbehaving source can never accidentally route to steer.
		const cases = [
			JSON.stringify({ type: "test", deliverAs: "STEER", id: "ev4" }),
			JSON.stringify({ type: "test", deliverAs: 42, id: "ev5" }),
			JSON.stringify({ type: "test", deliverAs: null, id: "ev6" }),
		];
		const script = `echo '${cases[0]}'\necho '${cases[1]}'\necho '${cases[2]}'`;
		manager.createSource({ name: "bad-deliveras", command: "sh", args: ["-c", script] }, CREATOR);

		await waitFor(() => broadcasts.filter((b) => b.sourceName === "bad-deliveras").length >= 3, 3_000, 20);
		const bs = broadcasts.filter((b) => b.sourceName === "bad-deliveras");
		expect(bs.length).toBeGreaterThanOrEqual(3);
		for (const b of bs) {
			expect(b.deliverAs).toBe("followUp");
		}
	});

	it("drops notifications that fail JSONRPC validation (no deliverAs leaked)", async () => {
		// Raw text with "deliverAs":"steer" embedded — validator should
		// reject it as invalid, so the broadcast callback never sees it
		// (and never sees a deliverAs value either).
		manager.createSource(
			{
				name: "raw-steer",
				command: "sh",
				args: ["-c", `echo 'pretend jsonrpc deliverAs=steer'`],
			},
			CREATOR,
		);

		// Wait for some output to happen (a source-error from supervisor on
		// idle exit), then assert no notification-shaped broadcast occurred.
		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "raw-steer" && b.line.startsWith("[source-error]")),
			3_000,
			20,
		);
		const notificationBroadcasts = broadcasts.filter(
			(b) => b.sourceName === "raw-steer" && !b.line.startsWith("[source-error]"),
		);
		expect(notificationBroadcasts).toHaveLength(0);
	});

	it("supervisor-error broadcasts always use followUp regardless of source content", async () => {
		// A source that emits a JSONRPC with deliverAs:steer but then
		// exits. The supervisor-error message goes to the creator with
		// followUp (not steer) so it doesn't accidentally interrupt.
		const line = emitNotification({ type: "test", id: "ev7", deliverAs: "steer" });
		manager.createSource(
			{
				name: "exit-after",
				command: "sh",
				args: ["-c", `echo '${line}'\nexit 0`],
			},
			CREATOR,
		);

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
		}
	});
});
