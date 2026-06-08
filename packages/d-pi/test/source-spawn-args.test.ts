import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";

/**
 * Regression coverage for sheason2019/pi-mono#7: the SourceManager
 * supervisor must spawn its child as a real argv vector, not as a
 * shell-joined string. The previous behaviour silently broke any
 * command whose args contained a literal space (e.g. `sh -c "exit 7"`),
 * because the supervisor handed the joined string to `/bin/sh -c` and
 * the shell re-tokenised it — `sh -c exit 7` is parsed as
 * `sh -c exit` with `$0=7`, so the child always exited 0 instead of 7.
 *
 * Each test below probes a different surface of that bug:
 *
 *   1. `multi-word inline script` — the original repro from #7.
 *   2. `whitespace inside a single arg` — an argv token whose value
 *      contains an internal space must reach the child as one token.
 *   3. `argv count and order` — the supervisor must hand the args
 *      through verbatim, in order, with the right length.
 *   4. `path containing whitespace` — a path argument that itself
 *      contains a space must be preserved; the old shell join would
 *      have split it into multiple tokens and the OS could no longer
 *      find the binary.
 *
 * No `shell: true` is set anywhere — these tests run against the
 * array-form spawn that the fix introduced.
 */

interface BroadcastCall {
	sourceName: string;
	line: string;
	subscriberAgentIds: string[];
}

const CREATOR = "spawn-args-creator";

const FAST_BACKOFF = {
	initialRestartDelayMs: 100,
	maxRestartDelayMs: 300,
	// Keep the restart budget generous so we can observe a non-zero
	// exit code without the supervisor giving up and flagging the
	// source `failed` mid-assertion.
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
	const manager = new SourceManager((sourceName, line, subscriberAgentIds) => {
		broadcasts.push({ sourceName, line, subscriberAgentIds });
	}, FAST_BACKOFF);
	return { manager, broadcasts };
}

describe("SourceManager spawn argv (regression for sheason2019/pi-mono#7)", () => {
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
		// Let SIGTERM/SIGKILL settle so vitest doesn't reap a zombie
		// mid-suite.
		await wait(50);
	});

	it('preserves a multi-word inline script (sh -c "exit 7")', async () => {
		// The canonical repro: `sh -c "exit 7"`. With the old shell-join
		// behaviour, the supervisor produced `sh -c exit 7` and the shell
		// re-tokenised it as `sh -c exit 7` (script=`exit`, $0=`7`) so the
		// child always exited 0. With argv spawn the child receives the
		// literal script "exit 7" and exits 7.
		manager.createSource(
			{
				name: "multi-word",
				command: "sh",
				args: ["-c", "exit 7"],
			},
			CREATOR,
		);

		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "multi-word" && b.line.startsWith("[source-error]")),
			3_000,
			20,
		);

		const exit = broadcasts.find((b) => b.sourceName === "multi-word" && b.line.startsWith("[source-error]"));
		expect(exit).toBeDefined();
		expect(exit?.line).toMatch(/code=7/);
	});

	it("preserves a single argv token that contains internal whitespace", async () => {
		// The shell joins with a single space, so a value like
		// `echo 'hello world'` (or any arg with an inner space) used to
		// get sliced into two tokens. After the fix, the whole string
		// reaches the child as one argv element. We assert on the
		// broadcasted stdout line — the script emits a valid JSONRPC 2.0
		// notification (matching the redesigned source contract; see
		// docs/superpowers/specs/2026-06-07-source-redesign-design.md),
		// which the supervisor streams back to its creator. The
		// substring "hello world" must survive the JSONRPC encoding
		// round-trip, proving that the inner-space argv token reached
		// the child intact.
		const notification = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { type: "test.spawn_args", data: { value: "hello world" } },
		});
		manager.createSource(
			{
				name: "whitespace",
				command: "sh",
				args: ["-c", `echo '${notification}'`],
			},
			CREATOR,
		);

		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "whitespace" && b.line.includes("hello world")),
			3_000,
			20,
		);

		const line = broadcasts.find((b) => b.sourceName === "whitespace" && b.line.includes("hello world"));
		expect(line).toBeDefined();
		expect(line?.line).toContain(notification);
		// The child should not have exited yet — `echo` then idle. But the
		// supervisor's restart timer will eventually fire on the idle
		// exit (code 0) so we don't assert on `status` here.
	});

	it("passes args through verbatim, preserving order and count", async () => {
		// `$#` is the number of positional parameters the script sees.
		// With `sh -c "exit $#" alpha "beta gamma" delta` the child gets
		// argv = [sh, -c, "exit $#", alpha, "beta gamma", delta] and
		// therefore $0="alpha", $1="beta gamma", $2="delta" — i.e. $#=2
		// ($# counts positional parameters, not including $0) → exit
		// code 2. A shell-join that re-tokenised the args would have
		// produced a different $# and therefore a different exit code.
		manager.createSource(
			{
				name: "argv-count",
				command: "sh",
				args: ["-c", "exit $#", "alpha", "beta gamma", "delta"],
			},
			CREATOR,
		);

		await waitFor(
			() => broadcasts.some((b) => b.sourceName === "argv-count" && b.line.startsWith("[source-error]")),
			3_000,
			20,
		);

		const exit = broadcasts.find((b) => b.sourceName === "argv-count" && b.line.startsWith("[source-error]"));
		expect(exit).toBeDefined();
		expect(exit?.line).toMatch(/code=2/);
	});

	it("preserves a path argument that itself contains whitespace", async () => {
		// A real-world failure mode: the user runs a script whose path
		// has a space in it (e.g. `~/My Scripts/runner.sh`). With
		// `shell: true` and a single-space join, the supervisor turned
		// the path into two tokens and the OS could not find the
		// binary. With argv spawn, the whole path is one argv element.
		//
		// We fabricate such a path under a temp dir; the script prints
		// a valid JSONRPC 2.0 notification to stdout (matching the
		// redesigned source contract; see
		// docs/superpowers/specs/2026-06-07-source-redesign-design.md)
		// and exits 11. Both the stdout broadcast and the exit code
		// are asserted.
		const notification = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { type: "test.spawn_args", data: { marker: "from-spacey-path" } },
		});
		const spaceyDir = mkdtempSync(join(tmpdir(), "d-pi-spawn-spaces-"));
		const scriptPath = join(spaceyDir, "my script.sh");
		writeFileSync(scriptPath, `echo '${notification}'; exit 11\n`, { mode: 0o755 });

		try {
			manager.createSource(
				{
					name: "spacey-path",
					command: "sh",
					args: [scriptPath],
				},
				CREATOR,
			);

			await waitFor(
				() => broadcasts.some((b) => b.sourceName === "spacey-path" && b.line.includes("from-spacey-path")),
				3_000,
				20,
			);
			await waitFor(
				() => broadcasts.some((b) => b.sourceName === "spacey-path" && b.line.startsWith("[source-error]")),
				3_000,
				20,
			);

			const stdout = broadcasts.find((b) => b.sourceName === "spacey-path" && b.line.includes("from-spacey-path"));
			expect(stdout).toBeDefined();
			expect(stdout?.line).toContain(notification);

			const exit = broadcasts.find((b) => b.sourceName === "spacey-path" && b.line.startsWith("[source-error]"));
			expect(exit).toBeDefined();
			// code=11 proves the child actually ran our script (it
			// would be something else — typically 127 — if the path
			// had been split and the binary could not be found).
			expect(exit?.line).toMatch(/code=11/);
		} finally {
			rmSync(spaceyDir, { recursive: true, force: true });
		}
	});
});
