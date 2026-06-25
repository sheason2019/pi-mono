import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDPiCli } from "../src/cli-runner.ts";
import { initWorkspace, isWorkspaceRoot } from "../src/workspace/workspace.ts";

let tmpRoot: string | undefined;

function freshWorkspace(): string {
	tmpRoot = join(tmpdir(), `d-pi-init-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	return tmpRoot;
}

describe("init template: strict-JSON output", () => {
	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
	});

	it("writes .dpi/config.json that JSON.parse accepts (no JS comments)", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const configPath = join(workspace, ".dpi", "config.json");
		expect(existsSync(configPath)).toBe(true);

		const raw = readFileSync(configPath, "utf-8");
		// Sanity: no JS-style line comments and no trailing commas
		expect(raw).not.toMatch(/\/\//);
		expect(raw).not.toMatch(/,[\s\n]*[}\]]/);

		// The point of the regression: strict JSON.parse must accept the file.
		JSON.parse(raw);
	});

	it("writes agents/root/agent.ts in the standard v3 schema", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const agentConfigPath = join(workspace, "agents", "root", "agent.ts");
		expect(existsSync(agentConfigPath)).toBe(true);
		expect(existsSync(join(workspace, "agents", "root", "agent.json"))).toBe(false);

		const raw = readFileSync(agentConfigPath, "utf-8");
		expect(raw).toContain("defineOpenAIProvider");
		expect(raw).toContain("defineProvider");
		expect(raw).toContain("export default defineAgent(");
		expect(raw).toContain('defineSkill({ dir: "./skills" })');
		expect(raw).toContain('defineContextFile({ type: "context", path: "./AGENTS.md" })');
		expect(raw).toContain('defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" })');
		expect(raw).not.toContain("parent:");
	});

	it("creates a workspace-level d-pi-message TUI component template", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const componentPath = join(workspace, "tui-components", "d-pi-message.ts");
		expect(existsSync(componentPath)).toBe(true);
		const raw = readFileSync(componentPath, "utf-8");
		expect(raw).toContain("@sheason/d-pi/.public/d-pi-message");
	});

	it("initializes the workspace as a node package linked to the current d-pi package", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const packageJsonPath = join(workspace, "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			private?: boolean;
			type?: string;
			dependencies?: Record<string, string>;
		};
		expect(packageJson.private).toBe(true);
		expect(packageJson.type).toBe("module");
		expect(packageJson.dependencies?.["@sheason/d-pi"]).toMatch(/^file:/);

		const linkedPackagePath = join(workspace, "node_modules", "@sheason", "d-pi");
		expect(lstatSync(linkedPackagePath).isSymbolicLink()).toBe(true);
		const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
		expect(realpathSync(linkedPackagePath)).toBe(realpathSync(packageRoot));
	});

	it("isWorkspaceRoot accepts the freshly-init config", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		// isWorkspaceRoot checks for the .dpi directory — the init template
		// must be canonical JSON on its own.
		expect(isWorkspaceRoot(workspace)).toBe(true);
	});

	it("JSON.parse rejects a hand-written config that still uses JS comments", () => {
		// Regression guard for the workaround removal: previously
		// validateWorkspace did `raw.replace(/\/\/.*$/gm, "")` before
		// JSON.parse, which silently masked hand-written `//` comments
		// (and the resulting trailing-comma SyntaxError). With the
		// workaround gone, a hand-written comment must surface as
		// a SyntaxError from JSON.parse.
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const configPath = join(workspace, ".dpi", "config.json");
		writeFileSync(
			configPath,
			`{
	// "someFutureField": "example"
}
`,
		);

		const raw = readFileSync(configPath, "utf-8");
		expect(() => JSON.parse(raw)).toThrowError(SyntaxError);
	});

	it("AGENTS.md template documents the optional workspace and agent config keys", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const agentsMd = readFileSync(join(workspace, "AGENTS.md"), "utf-8");
		const workspaceSection = agentsMd.split("## Agent Configuration")[0];
		expect(workspaceSection).not.toMatch(/includeTools/);
		expect(workspaceSection).not.toMatch(/excludeTools/);
		expect(workspaceSection).not.toMatch(/defaultModel/);
		// Agent-level keys
		expect(agentsMd).toMatch(/parent/);
		expect(agentsMd).toMatch(/description/);
		expect(agentsMd).toMatch(/defineOpenAIProvider/);
		expect(agentsMd).toMatch(/defineProvider/);
		expect(agentsMd).toMatch(/contextWindow/);
		expect(agentsMd).toMatch(/thinkingLevel/);
		expect(agentsMd).not.toMatch(/agent\.json/);
		expect(agentsMd).not.toMatch(/sessionId/);
	});

	it("CLI init clones a git team template into team-template when requested", async () => {
		const workspace = freshWorkspace();
		const stdout: string[] = [];
		const cloneTeamTemplate = vi.fn(async () => {});

		await runDPiCli(["init", "--team-template", "https://example.com/team-template.git"], {
			cwd: workspace,
			homeDir: workspace,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
			cloneTeamTemplate,
		});

		expect(cloneTeamTemplate).toHaveBeenCalledWith(
			"https://example.com/team-template.git",
			join(workspace, "team-template"),
		);
		expect(stdout.join("\n")).toContain("Cloned team template from https://example.com/team-template.git");
		expect(isWorkspaceRoot(workspace)).toBe(true);
	});

	it("CLI init output describes the root agent.ts layout", async () => {
		const workspace = freshWorkspace();
		const stdout: string[] = [];

		await runDPiCli(["init"], {
			cwd: workspace,
			homeDir: workspace,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		const output = stdout.join("\n");
		expect(output).toContain("agents/root/            — root agent working directory");
		expect(output).toContain("agents/root/agent.ts    — root agent definition");
		expect(output).not.toContain("agent.json");
	});

	it("CLI init rejects --team-template without a repository", async () => {
		const workspace = freshWorkspace();
		await expect(
			runDPiCli(["init", "--team-template"], {
				cwd: workspace,
				homeDir: workspace,
				stdout: () => {},
				stderr: () => {},
			}),
		).rejects.toThrow(/--team-template requires a git repository URL/);
		expect(existsSync(join(workspace, ".dpi"))).toBe(false);
	});
});
