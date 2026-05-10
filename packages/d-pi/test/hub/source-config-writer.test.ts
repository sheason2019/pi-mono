import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";
import {
	pauseSourceInConfig,
	removeSourceInConfig,
	resumeSourceInConfig,
} from "../../src/hub/sources/source-config-writer.js";

const tempDirs: string[] = [];

describe("source-config-writer", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function setupPiDir(cwd: string, content: string): void {
		const pi = join(cwd, ".pi");
		mkdirSync(pi, { recursive: true });
		writeFileSync(getSourcesConfigPath(cwd), content, "utf8");
	}

	it("pauseSourceInConfig sets disabled: true on a bare-array entry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-bare-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`[\n  {\n    "resourceId": "a",\n    "name": "a",\n    "transport": "stdio",\n    "command": "x"\n  }\n]\n`,
		);

		pauseSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as unknown;
		expect(Array.isArray(data)).toBe(true);
		const entry = (data as { name: string; disabled?: boolean }[])[0];
		expect(entry?.name).toBe("a");
		expect(entry?.disabled).toBe(true);
	});

	it("pauseSourceInConfig preserves wrapper shape", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-wrap-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify({ sources: [{ resourceId: "a", name: "a", transport: "stdio", command: "x" }] }, null, 2)}\n`,
		);

		pauseSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as {
			sources: { name: string; disabled?: boolean }[];
		};
		expect(Array.isArray((data as { sources?: unknown }).sources)).toBe(true);
		expect(data.sources[0]?.disabled).toBe(true);
	});

	it("pauseSourceInConfig preserves agentId on the entry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-agent-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x", agentId: "child-a" }], null, 2)}\n`,
		);

		pauseSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as unknown;
		const entry = (data as { name: string; agentId?: string; disabled?: boolean }[])[0];
		expect(entry?.name).toBe("a");
		expect(entry?.agentId).toBe("child-a");
		expect(entry?.disabled).toBe(true);
	});

	it("resumeSourceInConfig removes disabled key entirely", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-resume-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x", disabled: true }], null, 2)}\n`,
		);

		resumeSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as {
			name: string;
			disabled?: boolean;
		}[];
		const entry = data[0];
		expect(Object.hasOwn(entry, "disabled")).toBe(false);
	});

	it("resumeSourceInConfig preserves agentId on the entry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-resume-agent-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify(
				[{ resourceId: "a", name: "a", transport: "stdio", command: "x", agentId: "child-a", disabled: true }],
				null,
				2,
			)}\n`,
		);

		resumeSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as {
			name: string;
			agentId?: string;
			disabled?: boolean;
		}[];
		const entry = data[0];
		expect(entry?.name).toBe("a");
		expect(entry?.agentId).toBe("child-a");
		expect(Object.hasOwn(entry, "disabled")).toBe(false);
	});

	it("removeSourceInConfig drops the entry, preserves wrapper shape", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-rm-"));
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

		removeSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as unknown;
		expect(Array.isArray(data)).toBe(true);
		expect((data as { name: string }[]).map((e) => e.name)).toEqual(["b"]);
	});

	it("Each function throws when source name not found", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-miss-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x" }], null, 2)}\n`,
		);

		const re = /not found|unknown/i;
		expect(() => pauseSourceInConfig(cwd, "nope")).toThrow(re);
		expect(() => resumeSourceInConfig(cwd, "nope")).toThrow(re);
		expect(() => removeSourceInConfig(cwd, "nope")).toThrow(re);
	});

	it("Writes preserve unknown extra fields on entries", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-custom-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x", customField: 42 }], null, 2)}\n`,
		);

		pauseSourceInConfig(cwd, "a");

		const data = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as {
			customField: number;
			disabled: boolean;
		}[];
		expect(data[0]?.customField).toBe(42);
		expect(data[0]?.disabled).toBe(true);
	});

	it("Atomicity: a temp file does not remain after success", () => {
		const cwd = mkdtempSync(join(tmpdir(), "scw-atomic-"));
		tempDirs.push(cwd);
		setupPiDir(
			cwd,
			`${JSON.stringify([{ resourceId: "a", name: "a", transport: "stdio", command: "x" }], null, 2)}\n`,
		);

		pauseSourceInConfig(cwd, "a");

		const names = readdirSync(join(cwd, ".pi"));
		const leftovers = names.filter((n) => n.startsWith("sources.json.tmp") || n.includes("sources.json.tmp"));
		expect(leftovers).toEqual([]);
	});
});
