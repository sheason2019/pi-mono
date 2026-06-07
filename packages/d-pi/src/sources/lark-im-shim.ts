#!/usr/bin/env node
/**
 * lark-im-shim: translate lark-cli raw events to JSON-RPC 2.0 notifications.
 *
 * Reads lark-cli event consume output from stdin (one NDJSON event per line),
 * translates each message-shaped event into a JSONRPC 2.0 notification, and
 * writes one JSON line per notification to stdout. Lines that don't look
 * like a message event (ready markers, errors, non-JSON garbage) are
 * silently dropped — the hub's source-validator already filters anything
 * that isn't a valid notification, so we keep the shim's output clean.
 *
 * Output format per message event:
 *   {"jsonrpc":"2.0","method":"events.emit","params":{
 *     "type":"lark.message","id":"om_xxx","priority":"follow-up",
 *     "data":{...raw event payload}
 *   }}
 *
 * `priority` defaults to "follow-up" per Issue #3. Future: per-source
 * config to override.
 *
 * Usage (typically via the `notify.sh` wrapper):
 *   lark-cli event consume im.message.receive_v1 --as bot \
 *     | node lark-im-shim.ts
 */

import { createInterface } from "node:readline";

/**
 * Transform a single NDJSON input line into a JSONRPC notification string,
 * or `null` if the line doesn't represent a lark IM message event.
 *
 * Exported so tests can call it directly without spawning a child process.
 */
export function transformLine(line: string): string | null {
	let event: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(line);
		// Reject non-objects: null, arrays, primitives. They have no `event`
		// or `message` envelope to inspect.
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		event = parsed as Record<string, unknown>;
	} catch {
		// Invalid JSON from upstream — let the hub's validator decide whether
		// to warn. We don't emit anything because we can't synthesize a
		// meaningful notification from garbage.
		return null;
	}

	// lark-cli typically wraps fields under an `event` envelope (V2 schema),
	// but some EventKeys expose fields at the top level. Fall back so the
	// shim works for both shapes.
	const inner = (event.event as Record<string, unknown> | undefined) ?? event;
	const message = inner.message as Record<string, unknown> | undefined;
	if (!message) {
		// Non-message event (ready, error, heartbeat). Drop silently.
		return null;
	}

	const messageId = message.message_id;
	if (typeof messageId !== "string" || messageId.length === 0) {
		// Malformed message — no id means the agent can't correlate or ack.
		// Drop rather than emit a half-formed notification.
		return null;
	}

	const notification = {
		jsonrpc: "2.0",
		method: "events.emit",
		params: {
			type: "lark.message",
			id: messageId,
			priority: "follow-up",
			data: inner,
		},
	};
	return JSON.stringify(notification);
}

// ── Main: read stdin, transform each line, write to stdout ──────────────
// Only run the stdin loop when this file is executed directly. When
// imported by tests, `import.meta.url` points at this file but
// `process.argv[1]` points at vitest (or the test entry), so the
// comparison fails and we skip the loop.
const invokedDirectly = import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		const out = transformLine(line);
		if (out !== null) {
			process.stdout.write(`${out}\n`);
		}
	});
}
