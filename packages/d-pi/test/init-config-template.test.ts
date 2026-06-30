import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runDPiCli } from "../src/cli-runner.ts";
import { initWorkspace, isWorkspaceRoot } from "../src/workspace/workspace.ts";

let tmpRoot: string | undefined;

function freshWorkspace(): string {
	tmpRoot = join(tmpdir(), `d-pi-init-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	return tmpRoot;
}

describe("init template: convention-based layout", () => {
	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
	});

	it("writes agents/root/agent.ts in the convention-based minimal schema", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const agentConfigPath = join(workspace, "agents", "root", "agent.ts");
		expect(existsSync(agentConfigPath)).toBe(true);
		expect(existsSync(join(workspace, "agents", "root", "agent.json"))).toBe(false);

		const raw = readFileSync(agentConfigPath, "utf-8");
		expect(raw).toContain("defineAgent");
		expect(raw).toContain("export default defineAgent({");
		expect(raw).toContain("Convention-based agent configuration");
		expect(raw).not.toContain("defineSkill(");
		expect(raw).not.toContain("defineContextFile(");
		expect(raw).not.toContain("createDispatchBashTool");
		expect(raw).not.toContain("parent:");
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

	it("isWorkspaceRoot accepts the freshly-init workspace", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		expect(isWorkspaceRoot(workspace)).toBe(true);
	});

	it("AGENTS.md template documents convention-based workspace and agent config", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const agentsMd = readFileSync(join(workspace, "AGENTS.md"), "utf-8");
		expect(agentsMd).toMatch(/Workspace Resources/);
		expect(agentsMd).toMatch(/convention-based/);
		expect(agentsMd).toMatch(/AGENTS\.md/);
		expect(agentsMd).toMatch(/skills\//);
		expect(agentsMd).toMatch(/context\/\*\.md/);
		expect(agentsMd).toMatch(/tools\/\*\.ts/);
		expect(agentsMd).toMatch(/commands\/\*\.ts/);
		expect(agentsMd).toMatch(/Built-in tools/);
		expect(agentsMd).not.toMatch(/agent\.json/);
		expect(agentsMd).not.toMatch(/sessionId/);
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
});
