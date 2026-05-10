import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getChildAgentDir,
	getChildAgentSessionFile,
	getChildAgentsDir,
} from "../../src/hub/agents/child-agent-layout.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("child agent layout", () => {
	it("resolves workspace-local child agent directories and session files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-layout-"));
		tempDirs.push(cwd);

		expect(getChildAgentsDir(cwd)).toBe(join(cwd, ".child-agent"));
		expect(getChildAgentDir(cwd, "child-a")).toBe(join(cwd, ".child-agent", "child-a"));
		expect(getChildAgentSessionFile(cwd, "child-a")).toBe(join(cwd, ".child-agent", "child-a", "session.jsonl"));
	});

	it("rejects unsafe child agent ids", () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-layout-unsafe-"));
		tempDirs.push(cwd);

		expect(() => getChildAgentDir(cwd, "../evil")).toThrow(/Invalid agent id/);
		expect(() => getChildAgentSessionFile(cwd, "BadId")).toThrow(/Invalid agent id/);
	});
});
