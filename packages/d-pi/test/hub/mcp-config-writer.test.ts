import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMcpConfigPath } from "../../src/hub/mcp/mcp-config.js";
import { pauseServer, removeServer, restartServer } from "../../src/hub/mcp/mcp-config-writer.js";

const tempDirs: string[] = [];

describe("mcp-config-writer", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function setupPiDir(cwd: string, content: string): void {
		const pi = join(cwd, ".pi");
		mkdirSync(pi, { recursive: true });
		writeFileSync(getMcpConfigPath(cwd), content, "utf8");
	}

	it("round-trip preserves bare array root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-bare-"));
		tempDirs.push(cwd);
		const initial = `[\n  {\n    "resourceId": "a",\n    "name": "a",\n    "transport": "stdio",\n    "command": "x"\n  }\n]\n`;
		setupPiDir(cwd, initial);

		const r = pauseServer(cwd, "a");
		expect(r.ok).toBe(true);

		const data = JSON.parse(readFileSync(getMcpConfigPath(cwd), "utf8")) as unknown;
		expect(Array.isArray(data)).toBe(true);
		const entry = (data as { name: string; disabled?: boolean }[])[0];
		expect(entry?.name).toBe("a");
		expect(entry?.disabled).toBe(true);
	});

	it("round-trip preserves wrapper { servers: [...] } root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-wrap-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify({ servers: [{ resourceId: "a", name: "a", transport: "stdio", command: "x" }] }, null, 2)}\n`,
		);

		const r = pauseServer(cwd, "a");
		expect(r.ok).toBe(true);

		const data = JSON.parse(readFileSync(getMcpConfigPath(cwd), "utf8")) as {
			servers: { name: string; disabled?: boolean }[];
		};
		expect(Array.isArray(data.servers)).toBe(true);
		expect(data.servers[0]?.disabled).toBe(true);
	});

	it("pauseServer sets disabled: true on the target entry, leaves siblings untouched", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-pause-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify(
				[
					{ resourceId: "a", name: "a", transport: "stdio", command: "x" },
					{ resourceId: "b", name: "b", transport: "stdio", command: "y" },
				],
				null,
				2,
			)}\n`,
		);

		expect(pauseServer(cwd, "a").ok).toBe(true);
		const data = JSON.parse(readFileSync(getMcpConfigPath(cwd), "utf8")) as {
			name: string;
			disabled?: boolean;
		}[];
		expect(data[0]?.disabled).toBe(true);
		expect(Object.hasOwn(data[1]!, "disabled")).toBe(false);
	});

	it("restartServer removes disabled key (same as source resume)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-restart-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x", disabled: true }], null, 2)}\n`,
		);

		expect(restartServer(cwd, "a").ok).toBe(true);
		const data = JSON.parse(readFileSync(getMcpConfigPath(cwd), "utf8")) as {
			disabled?: boolean;
		}[];
		expect(Object.hasOwn(data[0]!, "disabled")).toBe(false);
	});

	it("removeServer deletes the entry and preserves array root shape", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-remove-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify(
				[
					{ resourceId: "a", name: "a", transport: "stdio", command: "x" },
					{ resourceId: "b", name: "b", transport: "stdio", command: "y" },
				],
				null,
				2,
			)}\n`,
		);

		expect(removeServer(cwd, "a").ok).toBe(true);
		const data = JSON.parse(readFileSync(getMcpConfigPath(cwd), "utf8")) as unknown;
		expect(Array.isArray(data)).toBe(true);
		expect((data as { name: string }[]).map((e) => e.name)).toEqual(["b"]);
	});

	it("mutators on unknown name return ok: false and do not modify the file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-unknown-"));
		tempDirs.push(cwd);
		const before = `${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x" }], null, 2)}\n`;
		setupPiDir(cwd, before);

		expect(pauseServer(cwd, "nope")).toEqual({ ok: false, error: expect.any(String) });
		expect(readFileSync(getMcpConfigPath(cwd), "utf8")).toBe(before);

		expect(restartServer(cwd, "nope")).toEqual({ ok: false, error: expect.any(String) });
		expect(readFileSync(getMcpConfigPath(cwd), "utf8")).toBe(before);

		expect(removeServer(cwd, "nope")).toEqual({ ok: false, error: expect.any(String) });
		expect(readFileSync(getMcpConfigPath(cwd), "utf8")).toBe(before);
	});

	it("writes preserve unknown extra fields on entries", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-extra-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x", customField: 42 }], null, 2)}\n`,
		);

		expect(pauseServer(cwd, "a").ok).toBe(true);
		const data = JSON.parse(readFileSync(getMcpConfigPath(cwd), "utf8")) as {
			customField: number;
			disabled: boolean;
		}[];
		expect(data[0]?.customField).toBe(42);
		expect(data[0]?.disabled).toBe(true);
	});

	it("atomicity: no leftover temp files under .pi after success (tmp + rename, same as source writer)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcpw-atomic-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x" }], null, 2)}\n`,
		);

		expect(pauseServer(cwd, "a").ok).toBe(true);
		const names = readdirSync(join(cwd, ".pi"));
		const leftovers = names.filter((n) => n.startsWith("mcp.json.tmp") || n.includes("mcp.json.tmp"));
		expect(leftovers).toEqual([]);
	});
});
