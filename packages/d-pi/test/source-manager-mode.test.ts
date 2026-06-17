import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";

/**
 * Unit + integration coverage for the per-event `mode` routing field.
 *
 * Sources declare a per-event `params.mode` in their JSONRPC
 * notification ("next" | "steer"). SourceManager parses it from the
 * validated notification and forwards it as the 4th argument to the
 * broadcast callback. Downstream (hub → worker → extension) maps it
 * 1:1 to `pi.sendMessage` options.
 *
 * The vocabulary mirrors the user-facing TUI's Enter / Ctrl+Enter
 * distinction so source authors don't have to think about internal
 * queue mechanics.
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
	mode: "next" | "steer";
}

const CREATOR = "mode-creator";

const FAST_BACKOFF = {
	initialRestartDelayMs: 100,
	maxRestartDelayMs: 300,
	maxRestartAttempts: 3,
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await wait(intervalMs);
	}
}

function emitLine(sourceName: string, mode: unknown, data: unknown = {}): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		method: "events.emit",
		params: {
			type: "test.event",
			id: `ev-${sourceName}`,
			mode,
			data,
		},
	});
}

describe("SourceManager mode coercion", () => {
	let broadcasts: BroadcastCall[];
	let manager: SourceManager;

	beforeEach(() => {
		broadcasts = [];
		manager = new SourceManager((sourceName, line, subscriberAgentIds, mode) => {
			broadcasts.push({ sourceName, line, subscriberAgentIds, mode });
		}, FAST_BACKOFF);
	});

	afterEach(async () => {
		manager.stopAll();
		await wait(50);
	});

	it("forwards mode='next' from a JSONRPC notification", async () => {
		const line = emitLine("next", "next", { marker: "next" });
		manager.setSource({ name: "next", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "next"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "next");
		expect(b?.mode).toBe("next");
	});

	it("forwards mode='steer' from a JSONRPC notification", async () => {
		const line = emitLine("steer", "steer", { marker: "steer" });
		manager.setSource({ name: "steer", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "steer"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "steer");
		expect(b?.mode).toBe("steer");
	});

	it("coerces missing mode to 'next'", async () => {
		// build the notification without the explicit `undefined` so the
		// mode field is omitted entirely from the wire payload.
		const noFieldLine = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: {
				type: "test.event",
				id: "ev-no-mode",
				data: { marker: "no-mode" },
			},
		});
		manager.setSource({ name: "no-mode", command: "sh", args: ["-c", `echo '${noFieldLine}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "no-mode"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "no-mode");
		expect(b?.mode).toBe("next");
	});

	it("coerces invalid mode values to 'next' (never silently degrades)", async () => {
		const invalidValues = ["followUp", "prompt", "all", "Next", "STEER", 42, true, null, {}];
		for (let i = 0; i < invalidValues.length; i++) {
			const name = `invalid-${i}`;
			const line = JSON.stringify({
				jsonrpc: "2.0",
				method: "events.emit",
				params: {
					type: "test.event",
					id: `ev-${name}`,
					mode: invalidValues[i],
					data: { marker: name },
				},
			});
			manager.setSource({ name, command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);
		}

		await waitFor(
			() => broadcasts.filter((b) => b.sourceName.startsWith("invalid-")).length === invalidValues.length,
			5_000,
			20,
		);
		for (const b of broadcasts.filter((b) => b.sourceName.startsWith("invalid-"))) {
			expect(b.mode, `name=${b.sourceName}`).toBe("next");
		}
	});

	it("does not read legacy deliverAs / drainMode fields (those are gone)", async () => {
		// A source that still emits deliverAs="steer" must NOT be treated
		// as a steer message — the field no longer exists, and any
		// unknown value coerces to "next".
		const line = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: {
				type: "test.event",
				id: "ev-legacy",
				deliverAs: "steer",
				drainMode: "one-at-a-time",
				data: { marker: "legacy" },
			},
		});
		manager.setSource({ name: "legacy", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "legacy"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "legacy");
		expect(b?.mode).toBe("next");
	});

	it("broadcast callback is invoked with exactly 4 args (no drainMode)", async () => {
		let observedArity: number | undefined;
		const local = new SourceManager((...args: unknown[]) => {
			observedArity = args.length;
		}, FAST_BACKOFF);
		try {
			const line = emitLine("arity", "next");
			local.setSource({ name: "arity", command: "sh", args: ["-c", `echo '${line}'`] }, CREATOR);
			await waitFor(() => observedArity !== undefined, 3_000, 20);
			expect(observedArity).toBe(4);
		} finally {
			local.stopAll();
		}
	});
});
