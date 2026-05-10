import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getSourcesConfigPath,
	loadChildSourcesConfigFromPath,
	loadSourcesConfig,
	loadSourcesConfigForAgents,
} from "../../src/hub/sources/source-config.js";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const tempDirs: string[] = [];

describe("sources config", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves sources file under .pi/sources.json", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-path-"));
		tempDirs.push(cwd);
		expect(getSourcesConfigPath(cwd)).toBe(join(cwd, ".pi", "sources.json"));
	});

	it("returns empty list when config file is missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-missing-"));
		tempDirs.push(cwd);
		expect(loadSourcesConfig(cwd)).toEqual([]);
	});

	it("loads valid stdio source entries from a bare JSON array root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-load-"));
		tempDirs.push(cwd);
		const piDir = join(cwd, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [
			{
				name: "alpha",
				transport: "stdio",
				command: "node",
				args: ["-e", "console.log(1)"],
				cwd: "/tmp",
				env: { FOO: "bar" },
			},
			{
				name: "beta",
				transport: "stdio",
				command: "my-cmd",
			},
		]);

		expect(loadSourcesConfig(cwd)).toEqual([
			{
				resourceId: expect.any(String),
				name: "alpha",
				transport: "stdio",
				command: "node",
				args: ["-e", "console.log(1)"],
				cwd: "/tmp",
				env: { FOO: "bar" },
			},
			{
				resourceId: expect.any(String),
				name: "beta",
				transport: "stdio",
				command: "my-cmd",
			},
		]);
	});

	it("still accepts a { sources: [...] } wrapper", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-wrapper-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), {
			sources: [{ name: "wrapped", transport: "stdio", command: "cmd" }],
		});
		expect(loadSourcesConfig(cwd)).toEqual([
			{ resourceId: expect.any(String), name: "wrapped", transport: "stdio", command: "cmd" },
		]);
	});

	it("rejects duplicate source names", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-dup-"));
		tempDirs.push(cwd);
		const piDir = join(cwd, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [
			{ name: "same", transport: "stdio", command: "a" },
			{ name: "same", transport: "stdio", command: "b" },
		]);

		expect(() => loadSourcesConfig(cwd)).toThrow(/duplicate/i);
	});

	it("rejects non-stdio transport", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-transport-"));
		tempDirs.push(cwd);
		const piDir = join(cwd, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "x", transport: "tcp", command: "noop" }]);

		expect(() => loadSourcesConfig(cwd)).toThrow(/transport/i);
	});

	it("rejects invalid root (neither array nor wrapper object)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-bad-root-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), "not-json-shape");
		expect(() => loadSourcesConfig(cwd)).toThrow(/Invalid sources config: root must be/i);
	});

	it('loads "disabled": true on a bare array entry', () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-disabled-true-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "alpha", transport: "stdio", command: "node", disabled: true }]);

		expect(loadSourcesConfig(cwd)).toEqual([
			{ resourceId: expect.any(String), name: "alpha", transport: "stdio", command: "node", disabled: true },
		]);
	});

	it('loads "disabled": false on a wrapper-object entry', () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-disabled-false-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), {
			sources: [{ name: "wrapped", transport: "stdio", command: "cmd", disabled: false }],
		});

		expect(loadSourcesConfig(cwd)).toEqual([
			{ resourceId: expect.any(String), name: "wrapped", transport: "stdio", command: "cmd", disabled: false },
		]);
	});

	it("omitted disabled stays undefined (not false)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-disabled-omit-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "alpha", transport: "stdio", command: "node" }]);

		const [entry] = loadSourcesConfig(cwd);
		expect(entry).toEqual({ resourceId: expect.any(String), name: "alpha", transport: "stdio", command: "node" });
		expect(Object.hasOwn(entry, "disabled")).toBe(false);
	});

	it('rejects non-boolean disabled (e.g., string "true")', () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-disabled-bad-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "alpha", transport: "stdio", command: "node", disabled: "true" }]);

		expect(() => loadSourcesConfig(cwd)).toThrow('Invalid source for "alpha": "disabled" must be a boolean');
	});

	it("rejects disabled as a number", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-disabled-number-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), {
			sources: [{ name: "wrapped", transport: "stdio", command: "cmd", disabled: 1 }],
		});

		expect(() => loadSourcesConfig(cwd)).toThrow('Invalid source for "wrapped": "disabled" must be a boolean');
	});

	it("omits agentId from loaded config when JSON has no agentId", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-omit-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "alpha", transport: "stdio", command: "node" }]);

		const [entry] = loadSourcesConfig(cwd);
		expect(entry).toEqual({ resourceId: expect.any(String), name: "alpha", transport: "stdio", command: "node" });
		expect("agentId" in entry! && entry!.agentId !== undefined).toBe(false);
	});

	it('loads "agentId" when set to a non-main id', () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-child-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "s", transport: "stdio", command: "node", agentId: "child-a" }]);

		const [e] = loadSourcesConfig(cwd);
		expect(e).toMatchObject({ name: "s", transport: "stdio", command: "node", agentId: "child-a" });
	});

	it('rejects empty string "agentId"', () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-empty-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "s", transport: "stdio", command: "node", agentId: "" }]);

		expect(() => loadSourcesConfig(cwd)).toThrow('Invalid source for "s": "agentId" must be a non-empty string');
	});

	it("rejects non-string agentId", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-badtype-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), {
			sources: [{ name: "s", transport: "stdio", command: "node", agentId: 1 }],
		});

		expect(() => loadSourcesConfig(cwd)).toThrow('Invalid source for "s": "agentId" must be a non-empty string');
	});

	it('rejects whitespace-only "agentId"', () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-ws-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [{ name: "s", transport: "stdio", command: "node", agentId: "   \t  " }]);

		expect(() => loadSourcesConfig(cwd)).toThrow('Invalid source for "s": "agentId" must be a non-empty string');
	});

	it("trims surrounding whitespace from agentId", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-trim-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [
			{ name: "s", transport: "stdio", command: "node", agentId: "  child-a  " },
		]);

		const [e] = loadSourcesConfig(cwd);
		expect(e).toMatchObject({ name: "s", agentId: "child-a" });
	});

	it("loads child source extends metadata without treating it as a source", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-child-extends-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".child-agent", "child-a"), { recursive: true });
		const path = join(cwd, ".child-agent", "child-a", "sources.json");
		writeJson(path, {
			extends: { host: { sources: ["ticker"] } },
			sources: [{ name: "child-only", transport: "stdio", command: "node" }],
		});

		expect(loadChildSourcesConfigFromPath(path)).toEqual({
			extends: { host: { sources: ["ticker"] } },
			sources: [{ resourceId: expect.any(String), name: "child-only", transport: "stdio", command: "node" }],
		});
	});

	it("silently overwrites duplicate source resourceIds with the last entry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-duplicate-id-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [
			{ resourceId: "same-id", name: "first", transport: "stdio", command: "first-cmd" },
			{ resourceId: "same-id", name: "second", transport: "stdio", command: "second-cmd" },
		]);

		expect(loadSourcesConfig(cwd)).toEqual([
			{ resourceId: "same-id", name: "second", transport: "stdio", command: "second-cmd" },
		]);
	});

	it("materializes selected host sources for child agents with child-scoped names and agent ids", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sources-agent-extends-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".child-agent", "child-a"), { recursive: true });
		writeJson(getSourcesConfigPath(cwd), [
			{ name: "ticker", transport: "stdio", command: "ticker-cmd" },
			{ name: "drop", transport: "stdio", command: "drop-cmd" },
			{ name: "other-child", transport: "stdio", command: "other-cmd", agentId: "child-b" },
		]);
		writeJson(join(cwd, ".child-agent", "child-a", "sources.json"), {
			extends: { host: { sources: ["ticker"] } },
			sources: [{ name: "local", transport: "stdio", command: "local-cmd" }],
		});

		expect(loadSourcesConfigForAgents(cwd, ["child-a"])).toEqual([
			{ resourceId: expect.any(String), name: "ticker", transport: "stdio", command: "ticker-cmd" },
			{ resourceId: expect.any(String), name: "drop", transport: "stdio", command: "drop-cmd" },
			{
				resourceId: expect.any(String),
				name: "other-child",
				transport: "stdio",
				command: "other-cmd",
				agentId: "child-b",
			},
			{
				resourceId: expect.stringMatching(/^child-a:/),
				name: "ticker",
				transport: "stdio",
				command: "ticker-cmd",
				agentId: "child-a",
			},
			{
				resourceId: expect.stringMatching(/^child-a:/),
				name: "local",
				transport: "stdio",
				command: "local-cmd",
				agentId: "child-a",
			},
		]);
	});
});
