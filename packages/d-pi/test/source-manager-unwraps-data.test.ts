import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";

/**
 * Coverage for the "unwrap JSONRPC envelope" behaviour in SourceManager.
 *
 * Sources emit JSONRPC 2.0 notifications of the shape:
 *   { jsonrpc: "2.0", method: "events.emit", params: { type, id, mode, data } }
 *
 * The `jsonrpc` / `method` / `params.type` / `params.id` / `params.mode`
 * fields are wire-protocol detail. Subscribed agents don't need to see
 * them — they only want the upstream event payload (params.data).
 *
 * SourceManager._onLine therefore parses the line, extracts `mode`
 * for routing, and forwards ONLY `params.data` (JSON-stringified) to
 * the broadcast callback. The hub then wraps the data in a
 * `[meta({sourceName, ...})]\n` header before delivery to the agent.
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
	mode: "next" | "steer";
}

const CREATOR = "unwrap-creator";

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

function buildLine(params: { type: string; id: string; mode?: unknown; data: unknown }): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		method: "events.emit",
		params,
	});
}

describe("SourceManager unwraps JSONRPC envelope", () => {
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

	it("forwards only params.data (stringified) — drops jsonrpc/method/params.type/params.id", async () => {
		const larkEvent = {
			schema: "2.0",
			event_id: "evt_123",
			event_type: "im.message.receive_v1",
			message: { chat_id: "oc_abc", content: '{"text":"hi"}' },
		};
		const line = buildLine({
			type: "im.message.receive_v1",
			id: "evt_123",
			mode: "steer",
			data: larkEvent,
		});
		manager.createSource(
			{ name: "lark-bot", command: "sh", args: ["-c", `echo '${line}'`] },
			CREATOR,
		);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "lark-bot"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "lark-bot");
		expect(b).toBeDefined();

		// Forwarded body is exactly the params.data payload, not the
		// full JSONRPC notification.
		expect(b!.line).toBe(JSON.stringify(larkEvent));
		// The forwarded body parses back to the same object.
		expect(JSON.parse(b!.line)).toEqual(larkEvent);
		// And the JSONRPC envelope is gone — no "jsonrpc" / "method" /
		// "params" keys in the forwarded payload.
		const parsed = JSON.parse(b!.line);
		expect(parsed).not.toHaveProperty("jsonrpc");
		expect(parsed).not.toHaveProperty("method");
		expect(parsed).not.toHaveProperty("params");
	});

	it("still extracts mode for routing (the only thing kept from the envelope)", async () => {
		const line = buildLine({
			type: "im.message.receive_v1",
			id: "evt_456",
			mode: "steer",
			data: { hello: "world" },
		});
		manager.createSource(
			{ name: "lark-bot", command: "sh", args: ["-c", `echo '${line}'`] },
			CREATOR,
		);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "lark-bot"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "lark-bot");
		expect(b!.mode).toBe("steer");
	});

	it("preserves string data verbatim (no double JSON encoding)", async () => {
		const rawJson = '{"already":"serialized","nested":{"k":"v"}}';
		const line = buildLine({
			type: "im.message.receive_v1",
			id: "evt_789",
			mode: "next",
			data: rawJson,
		});
		manager.createSource(
			{ name: "string-data", command: "sh", args: ["-c", `echo '${line}'`] },
			CREATOR,
		);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "string-data"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "string-data");
		// String data is passed through without re-serialization.
		expect(b!.line).toBe(rawJson);
	});

	it("falls back to the full line if data is missing (defensive)", async () => {
		const line = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { type: "test.event", id: "ev-no-data" },
		});
		manager.createSource(
			{ name: "no-data", command: "sh", args: ["-c", `echo '${line}'`] },
			CREATOR,
		);

		await waitFor(() => broadcasts.some((b) => b.sourceName === "no-data"), 3_000, 20);
		const b = broadcasts.find((b) => b.sourceName === "no-data");
		// Better to forward the full notification than to drop the
		// event entirely — the LLM can still read the envelope.
		expect(b!.line).toBe(line);
	});
});
