#!/usr/bin/env node
/**
 * lark-health-shim: translate lark-cli health-check stdout lines to JSONRPC.
 *
 * Reads `scripts/lark-health-check/run.sh` output from stdin. Each line
 * matches the shape:
 *   [health-check] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=894190)
 * and is translated to a JSONRPC 2.0 notification:
 *   {"jsonrpc":"2.0","method":"events.emit","params":{
 *     "type":"health.report","timestamp":"...","status":"OK","bus_pid":...}}
 *
 * Lines that don't match the expected shape (lark-cli startup noise,
 * ready markers, partial output) are silently dropped.
 *
 * Usage (typically via the `health-notify.sh` wrapper):
 *   sh scripts/lark-health-check/run.sh | node lark-health-shim.ts
 */

import { createInterface } from "node:readline";

// Match: [health-check] <ISO-ish timestamp> <service> <status> (bus_pid=<digits|none>)
// - timestamp: YYYY-MM-DDTHH:MM:SS with optional fractional seconds and timezone
// - service:   any non-whitespace token (forward as-is for downstream)
// - status:    any non-whitespace token (forward whatever the script emits)
// - bus_pid:   integer or the literal "none"
const HEALTH_RE =
	/^\[health-check\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(\S+)\s+(\S+)\s+\(bus_pid=(\d+|none)\)/;

/**
 * Transform a single input line into a JSONRPC notification string, or
 * `null` if the line doesn't match the expected health-check shape.
 *
 * Exported so tests can call it directly without spawning a child process.
 */
export function transformLine(line: string): string | null {
	const m = line.match(HEALTH_RE);
	if (!m) {
		// Not a health-check line — lark-cli noise, blank lines, partial output.
		return null;
	}

	const [, timestamp, service, status, busPidRaw] = m;
	const notification = {
		jsonrpc: "2.0",
		method: "events.emit",
		params: {
			type: "health.report",
			timestamp,
			service,
			status,
			bus_pid: busPidRaw === "none" ? null : Number.parseInt(busPidRaw, 10),
		},
	};
	return JSON.stringify(notification);
}

// ── Main: read stdin, transform each line, write to stdout ──────────────
// Only run the stdin loop when this file is executed directly. When
// imported by tests, `import.meta.url` points at this file but
// `process.argv[1]` points at vitest, so the comparison fails and we
// skip the loop.
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
