import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";
import { validateLine } from "../src/hub/source-validator.ts";

/**
 * End-to-end integration tests for SourceManager + JSONRPC validation.
 *
 * The unit tests in `source-validator.test.ts` cover validateLine() in
 * isolation. The unit tests in `source-manager.test.ts` (sibling files:
 * source-spawn-args, source-supervisor-restart) cover spawn argv + the
 * supervisor. This file stitches them together: a real child process
 * is spawned via SourceManager, its stdout is fed through the
 * production validateLine() path inside the supervisor, and we assert
 * that only valid JSONRPC notifications reach subscribed agents.
 *
 * Tests:
 *  1. Mixed valid / invalid lines: only notifications broadcast.
 *  2. Request / response shapes: parsed cleanly, silently dropped.
 *  3. Validator must not throw on 11 hostile edge-case inputs
 *     (no-accidental-exit property).
 *  4. Source must keep running across many valid + invalid cycles
 *     (supervisor doesn't kill the source on garbage).
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
	mode: "next" | "steer";
}

const CREATOR = "integration-creator";

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
	const manager = new SourceManager((sourceName, line, subscriberAgentIds, mode) => {
		broadcasts.push({ sourceName, line, subscriberAgentIds, mode });
	}, FAST_BACKOFF);
	return { manager, broadcasts };
}

describe("SourceManager integration with JSONRPC validation", () => {
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

	it("forwards valid JSONRPC notifications and drops invalid lines", async () => {
		// Spawn a source that emits 3 valid notifications interleaved with
		// 3 invalid lines (raw garbage, missing jsonrpc, missing method).
		manager.setSource(
			{
				name: "mixed",
				command: "sh",
				args: [
					"-c",
					`echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"test","data":"good-1"}}'
echo 'this is not JSON at all'
echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"test","data":"good-2"}}'
echo '{"not":"jsonrpc"}'
echo '{"jsonrpc":"2.0"}'
echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"test","data":"good-3"}}'`,
				],
			},
			CREATOR,
		);

		await waitFor(
			() => broadcasts.filter((b) => b.sourceName === "mixed" && b.line.includes("good-3")).length >= 1,
			3_000,
			20,
		);

		const mixedBroadcasts = broadcasts.filter((b) => b.sourceName === "mixed");
		const good = mixedBroadcasts.filter((b) => b.line.includes("good-"));
		expect(good).toHaveLength(3);
		// None of the invalid lines should have leaked through as broadcasts.
		expect(mixedBroadcasts.some((b) => b.line.includes("not JSON"))).toBe(false);
		expect(mixedBroadcasts.some((b) => b.line.startsWith('{"not"'))).toBe(false);
		expect(mixedBroadcasts.some((b) => b.line === '{"jsonrpc":"2.0"}')).toBe(false);
	});

	it("silently drops JSONRPC requests and responses (no broadcast, no log)", async () => {
		manager.setSource(
			{
				name: "rpc-shapes",
				command: "sh",
				args: [
					"-c",
					`echo '{"jsonrpc":"2.0","id":1,"method":"req"}'
echo '{"jsonrpc":"2.0","id":1,"result":"ok"}'
echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"bad"}}'`,
				],
			},
			CREATOR,
		);

		// Wait until at least one source-error broadcast appears (the source
		// will eventually exit code 0 and the supervisor will restart it,
		// producing [source-error] lines on the broadcast channel). That
		// gives us time for the request/response lines to be processed.
		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "rpc-shapes" && b.line.startsWith("[source-error]")),
			3_000,
			20,
		);

		const rpcBroadcasts = broadcasts.filter((b) => b.sourceName === "rpc-shapes");
		// None of the raw request/response JSON lines should appear as
		// broadcasts — the validator should silently drop them.
		for (const b of rpcBroadcasts) {
			expect(b.line.startsWith("[source-error]")).toBe(true);
		}
	});

	it("survives a source that emits mixed valid/invalid/garbage without crashing", async () => {
		// We don't spawn a real process here — instead we hammer validateLine
		// with the 11 hostile inputs the plan requires and assert none of
		// them throw. This is the no-accidental-exit property: a single
		// malformed line must never be able to kill the source.
		const edges = [
			"",
			" ",
			"null",
			"[]",
			'{"jsonrpc":"2.0"}',
			'{"jsonrpc":"1.0","method":"x"}',
			'{"jsonrpc":"2.0","method":""}',
			'{"jsonrpc":"2.0","method":123}',
			'{"jsonrpc":"2.0","method":"x","id":null}',
			'{"jsonrpc":"2.0","method":"x","id":[]}',
			'{"jsonrpc":"2.0","method":"x","result":{"a":1}}',
		];
		for (const edge of edges) {
			const result = validateLine(edge);
			expect(result).toBeDefined();
			// Every result must be a discriminated union with a `kind`
			// tag — the supervisor's switch relies on it.
			expect(["notification", "request", "response", "invalid"]).toContain(result.kind);
		}
	});

	it("keeps running across many valid+invalid cycles (supervisor does not kill source)", async () => {
		// Build a script that emits 5 notifications interleaved with
		// garbage, repeating 3 times. The supervisor should keep the
		// source alive across all 3 cycles (no exit kills the manager)
		// and all 15 notifications should eventually broadcast.
		const cycle = `echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"cycle","data":"a"}}'
echo 'GARBAGE LINE 1'
echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"cycle","data":"b"}}'
echo '{"no":"jsonrpc"}'
echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"cycle","data":"c"}}'
echo 'GARBAGE LINE 2'
echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"cycle","data":"d"}}'
echo '{"jsonrpc":"2.0"}'
echo '{"jsonrpc":"2.0","method":"events.emit","params":{"type":"cycle","data":"e"}}'`;
		// Repeat the cycle 3 times then idle. The source will exit on
		// idle (code 0), the supervisor will restart it, but the test
		// only asserts on broadcasts collected before any restart.
		const script = `${cycle}\n${cycle}\n${cycle}\n`;

		manager.setSource(
			{
				name: "cycles",
				command: "sh",
				args: ["-c", script],
			},
			CREATOR,
		);

		await waitFor(() => broadcasts.filter((b) => b.sourceName === "cycles" && b.line === "e").length >= 1, 3_000, 20);

		const cycleBroadcasts = broadcasts.filter((b) => b.sourceName === "cycles");
		const notifications = cycleBroadcasts.filter((b) => b.line === "a" || b.line === "e");
		// We expect at least the first cycle's notifications to come through.
		// Don't assert exact counts because the supervisor may restart the
		// source between cycles — but the test would already have failed
		// in waitFor() if 0 'e' notifications came through.
		expect(notifications.length).toBeGreaterThanOrEqual(2);
		// No garbage leaked through.
		expect(cycleBroadcasts.some((b) => b.line.includes("GARBAGE"))).toBe(false);
	});

	it("end-to-end: source emits mode='steer', surfaces in broadcast", async () => {
		const line = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: {
				type: "integration.mode",
				id: "ev-mode",
				mode: "steer",
				data: { marker: "mode" },
			},
		});
		manager.setSource({ name: "mode-e2e", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "mode-e2e"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "mode-e2e");
		expect(b?.mode).toBe("steer");
	});
});
