import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end smoke tests for the lark-source-formatter wrapper scripts.
 *
 * The wrappers pipe an upstream command (lark-cli, or the health-check
 * script) through `tsx <shim>.ts`. The shims themselves are unit-tested
 * in `lark-im-shim.test.ts` / `lark-health-shim.test.ts`; here we verify
 * the bash glue: PATH lookup, executable bit, shim resolution, and
 * stdout/stderr pass-through.
 *
 * Strategy: drop a fake upstream binary into a temp dir, prepend that
 * dir to PATH (or use LARK_CLI_BIN / HEALTH_SCRIPT env overrides), and
 * spawn the wrapper. The fake emits one line so we can assert on the
 * JSONRPC notification the wrapper produces on stdout.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const NOTIFY_SH = join(REPO_ROOT, "scripts", "lark-source-formatter", "notify.sh");
const HEALTH_NOTIFY_SH = join(REPO_ROOT, "scripts", "lark-source-formatter", "health-notify.sh");

let mockBinDir: string;

beforeEach(() => {
	mockBinDir = mkdtempSync(join(tmpdir(), "d-pi-mock-bin-"));
});

afterEach(() => {
	rmSync(mockBinDir, { recursive: true, force: true });
});

function writeMockBinary(name: string, body: string): string {
	const path = join(mockBinDir, name);
	writeFileSync(path, body, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

function runWrapper(
	scriptPath: string,
	envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve) => {
		const child = spawn("bash", [scriptPath], {
			env: {
				...process.env,
				PATH: `${mockBinDir}:${process.env.PATH ?? ""}`,
				...envOverrides,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout!.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => resolve({ stdout, stderr, code }));
	});
}

function syntaxCheck(scriptPath: string): Promise<number | null> {
	return new Promise((resolve) => {
		const p = spawn("bash", ["-n", scriptPath], { stdio: "ignore" });
		p.on("close", (c) => resolve(c));
	});
}

describe("lark-source-formatter/notify.sh", () => {
	it("has valid bash syntax", async () => {
		expect(await syntaxCheck(NOTIFY_SH)).toBe(0);
	});

	it("translates a fake lark-cli message event to JSONRPC notification", async () => {
		writeMockBinary(
			"lark-cli",
			`#!/usr/bin/env bash
echo '{"type":"im.message.receive_v1","event":{"message":{"message_id":"om_e2e","chat_id":"oc_x"}}}'
`,
		);
		const { stdout, code } = await runWrapper(NOTIFY_SH);
		expect(code).toBe(0);
		const lines = stdout
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.method).toBe("events.emit");
		expect(parsed.params.type).toBe("lark.message");
		expect(parsed.params.id).toBe("om_e2e");
	});

	it("drops non-message events (no JSONRPC output on stdout)", async () => {
		writeMockBinary(
			"lark-cli",
			`#!/usr/bin/env bash
echo '{"type":"system.ready"}'
`,
		);
		const { stdout, code } = await runWrapper(NOTIFY_SH);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
	});

	it("respects LARK_CLI_BIN env override", async () => {
		// Custom-named mock binary the wrapper discovers via env, not PATH.
		const mockPath = writeMockBinary(
			"my-lark-mock",
			`#!/usr/bin/env bash
echo '{"event":{"message":{"message_id":"om_env","chat_id":"oc_env"}}}'
`,
		);
		const { stdout, code } = await runWrapper(NOTIFY_SH, { LARK_CLI_BIN: mockPath });
		expect(code).toBe(0);
		const lines = stdout
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.params.id).toBe("om_env");
	});
});

describe("lark-source-formatter/health-notify.sh", () => {
	it("has valid bash syntax", async () => {
		expect(await syntaxCheck(HEALTH_NOTIFY_SH)).toBe(0);
	});

	it("translates a [health-check] line to a JSONRPC notification", async () => {
		const mockHealth = writeMockBinary(
			"fake-health",
			`#!/usr/bin/env bash
echo "[health-check] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=42)"
`,
		);
		const { stdout, code } = await runWrapper(HEALTH_NOTIFY_SH, { HEALTH_SCRIPT: mockHealth });
		expect(code).toBe(0);
		const lines = stdout
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.method).toBe("events.emit");
		expect(parsed.params.type).toBe("health.report");
		expect(parsed.params.status).toBe("OK");
		expect(parsed.params.bus_pid).toBe(42);
	});

	it("drops non-health lines (no JSONRPC output on stdout)", async () => {
		const mockHealth = writeMockBinary(
			"fake-health",
			`#!/usr/bin/env bash
echo "[event] ready event_key=im.message.receive_v1"
`,
		);
		const { stdout, code } = await runWrapper(HEALTH_NOTIFY_SH, { HEALTH_SCRIPT: mockHealth });
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("");
	});
});
