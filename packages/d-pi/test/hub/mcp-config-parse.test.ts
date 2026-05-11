import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMcpConfigPath, parseMcpConfig, readMcpConfig } from "../../src/hub/mcp/mcp-config.js";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const tempDirs: string[] = [];

describe("mcp config parse", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves mcp file under .pi/mcp.json", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-mcp-path-"));
		tempDirs.push(cwd);
		expect(getMcpConfigPath(cwd)).toBe(join(cwd, ".pi", "mcp.json"));
	});

	it("parseMcpConfig: root array form parses to the same servers as wrapped { servers: [...] }", () => {
		const arrayRoot = [
			{
				name: "a",
				transport: "stdio",
				command: "npx",
				args: ["-y", "pkg"],
			},
			{
				name: "b",
				transport: "http",
				url: "https://example.com/sse",
			},
		];
		const wrapped = { servers: arrayRoot };

		const a = parseMcpConfig(arrayRoot);
		const b = parseMcpConfig(wrapped);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) {
			expect(a.servers).toEqual(b.servers);
			expect(a.wrapper).toBe("array");
			expect(b.wrapper).toBe("object");
		}
	});

	it("parseMcpConfig: preserves disabled true, false, and omits when omitted (enabled)", () => {
		const t = parseMcpConfig([{ name: "t", transport: "stdio", command: "c", disabled: true }]);
		const f = parseMcpConfig([{ name: "f", transport: "stdio", command: "c", disabled: false }]);
		const o = parseMcpConfig([{ name: "o", transport: "stdio", command: "c" }]);
		expect(t.ok).toBe(true);
		expect(f.ok).toBe(true);
		expect(o.ok).toBe(true);
		if (t.ok && f.ok && o.ok) {
			expect(t.servers[0]).toEqual({ resourceId: "t", name: "t", transport: "stdio", command: "c", disabled: true });
			expect(f.servers[0]).toEqual({
				resourceId: "f",
				name: "f",
				transport: "stdio",
				command: "c",
				disabled: false,
			});
			expect(o.servers[0]).toEqual({ resourceId: "o", name: "o", transport: "stdio", command: "c" });
			expect(Object.hasOwn(o.servers[0]!, "disabled")).toBe(false);
		}
	});

	it("parseMcpConfig: preserves positive per-server timeoutMs", () => {
		const r = parseMcpConfig([{ name: "slow", transport: "stdio", command: "c", timeoutMs: 60_000 }]);

		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers[0]).toEqual({
				resourceId: "slow",
				name: "slow",
				transport: "stdio",
				command: "c",
				timeoutMs: 60_000,
			});
		}
	});

	it("parseMcpConfig: rejects invalid per-server timeoutMs", () => {
		const r = parseMcpConfig([{ name: "slow", transport: "stdio", command: "c", timeoutMs: 0 }]);

		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/timeoutMs/i);
		}
	});

	it("parseMcpConfig: stdio entry maps command, args, cwd, env", () => {
		const r = parseMcpConfig([
			{
				name: "s",
				transport: "stdio",
				command: "node",
				args: ["-e", "1"],
				cwd: "/tmp",
				env: { FOO: "bar" },
			},
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers[0]).toEqual({
				resourceId: "s",
				name: "s",
				transport: "stdio",
				command: "node",
				args: ["-e", "1"],
				cwd: "/tmp",
				env: { FOO: "bar" },
			});
		}
	});

	it("parseMcpConfig: http entry maps url and headers", () => {
		const r = parseMcpConfig([
			{
				name: "h",
				transport: "http",
				url: "https://mcp.example/sse",
				headers: { Authorization: "Bearer x" },
			},
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers[0]).toEqual({
				resourceId: "h",
				name: "h",
				transport: "http",
				url: "https://mcp.example/sse",
				headers: { Authorization: "Bearer x" },
			});
		}
	});

	it("parseMcpConfig: missing name returns structured error", () => {
		const r = parseMcpConfig([{ transport: "stdio", command: "c" }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/name/i);
		}
	});

	it("parseMcpConfig: stdio missing command returns structured error", () => {
		const r = parseMcpConfig([{ name: "x", transport: "stdio" }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/command/i);
		}
	});

	it("parseMcpConfig: http missing url returns structured error", () => {
		const r = parseMcpConfig([{ name: "x", transport: "http" }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/url/i);
		}
	});

	it("parseMcpConfig: invalid name with __ returns structured error", () => {
		const r = parseMcpConfig([{ name: "a__b", transport: "stdio", command: "c" }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/name|__/i);
		}
	});

	it("parseMcpConfig: invalid name with disallowed characters returns structured error", () => {
		const r = parseMcpConfig([{ name: "bad.name", transport: "stdio", command: "c" }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/name/i);
		}
	});

	it("parseMcpConfig: unknown transport returns structured error", () => {
		const r = parseMcpConfig([{ name: "x", transport: "tcp", command: "c" }]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/transport/i);
		}
	});

	it("parseMcpConfig: unknown extra fields on an entry are accepted (do not fail parse)", () => {
		const r = parseMcpConfig([{ name: "x", transport: "stdio", command: "c", futureFlag: 1, nested: { a: 1 } }]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers[0]).toEqual({ resourceId: "x", name: "x", transport: "stdio", command: "c" });
		}
	});

	it("parseMcpConfig: duplicate resourceIds are silently overwritten by the last entry", () => {
		const r = parseMcpConfig([
			{ resourceId: "same-id", name: "first", transport: "stdio", command: "first-cmd" },
			{ resourceId: "same-id", name: "second", transport: "stdio", command: "second-cmd" },
		]);

		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers).toEqual([
				{ resourceId: "same-id", name: "second", transport: "stdio", command: "second-cmd" },
			]);
		}
	});

	it("readMcpConfig: missing file is not an error; returns empty servers and array wrapper", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-mcp-missing-"));
		tempDirs.push(cwd);
		const r = readMcpConfig(cwd);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers).toEqual([]);
			expect(r.wrapper).toBe("array");
		}
	});

	it("readMcpConfig: loads valid file from disk", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-mcp-read-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getMcpConfigPath(cwd), [{ name: "a", transport: "stdio", command: "c" }]);
		const r = readMcpConfig(cwd);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.servers).toEqual([{ resourceId: expect.any(String), name: "a", transport: "stdio", command: "c" }]);
			expect(r.wrapper).toBe("array");
		}
	});
});
