import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAddSkills } from "../../src/hub/commands/add-skills.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("pi-hub add-skills", () => {
	it("installs the built-in agent guidance skills into the workspace .pi skills directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-add-skills-"));
		tempDirs.push(cwd);

		const result = runAddSkills({ cwd, log: () => {} });

		const configSkillPath = join(cwd, ".pi", "skills", "pi-agent-config-editing", "SKILL.md");
		const e2eSkillPath = join(cwd, ".pi", "skills", "reproducing-real-bugs-with-e2e", "SKILL.md");
		expect(result.installed).toEqual([configSkillPath, e2eSkillPath]);
		expect(existsSync(configSkillPath)).toBe(true);
		expect(readFileSync(configSkillPath, "utf8")).toContain("name: pi-agent-config-editing");
		const configContent = readFileSync(configSkillPath, "utf8");
		expect(configContent).toContain("mcp.json");
		expect(configContent).toContain("sources.json");
		expect(configContent).toContain("MCP Server Implementation");
		expect(configContent).toContain("StdioServerTransport");
		expect(configContent).toContain("queue/write");
		expect(configContent).toContain("There is no initialize/source/subscribe/source/message handshake");
		expect(configContent).toContain("No automatic PI_SOURCE_* variables are injected");
		expect(configContent).toContain("Relative files in skills");
		expect(existsSync(e2eSkillPath)).toBe(true);
		const e2eContent = readFileSync(e2eSkillPath, "utf8");
		expect(e2eContent).toContain("name: reproducing-real-bugs-with-e2e");
		expect(e2eContent).toContain("Real Topology First");
		expect(e2eContent).toContain("tmux");
		expect(e2eContent).toContain("regression test");
	});
});
