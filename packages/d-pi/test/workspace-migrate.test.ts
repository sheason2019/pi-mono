import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDPiCli } from "../src/cli-runner.ts";
import { migrateWorkspace, TARGET_WORKSPACE_VERSION } from "../src/workspace/workspace.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

function writeWorkspaceConfig(workspaceRoot: string, version: number): void {
	mkdirSync(join(workspaceRoot, ".dpi"), { recursive: true });
	writeFileSync(join(workspaceRoot, ".dpi", "config.json"), `${JSON.stringify({ version }, null, "\t")}\n`);
}

function readWorkspaceVersion(workspaceRoot: string): number {
	const raw = readFileSync(join(workspaceRoot, ".dpi", "config.json"), "utf-8");
	return (JSON.parse(raw) as { version: number }).version;
}

describe("workspace migration", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
		vi.restoreAllMocks();
	});

	it("migrates version 1 by renaming group-architecture to team-template", () => {
		const workspaceRoot = createTempDir("d-pi-migrate-");
		writeWorkspaceConfig(workspaceRoot, 1);
		mkdirSync(join(workspaceRoot, "group-architecture", "roles", "reviewer"), { recursive: true });
		writeFileSync(join(workspaceRoot, "group-architecture", "roles", "reviewer", "AGENTS.md"), "reviewer role");

		const result = migrateWorkspace(workspaceRoot);

		expect(result).toEqual({ fromVersion: 1, toVersion: TARGET_WORKSPACE_VERSION, renamedGroupArchitecture: true });
		expect(existsSync(join(workspaceRoot, "group-architecture"))).toBe(false);
		expect(readFileSync(join(workspaceRoot, "team-template", "roles", "reviewer", "AGENTS.md"), "utf-8")).toBe(
			"reviewer role",
		);
		expect(readWorkspaceVersion(workspaceRoot)).toBe(TARGET_WORKSPACE_VERSION);
	});

	it("does not overwrite team-template when both directories exist", () => {
		const workspaceRoot = createTempDir("d-pi-migrate-conflict-");
		writeWorkspaceConfig(workspaceRoot, 1);
		mkdirSync(join(workspaceRoot, "group-architecture"), { recursive: true });
		mkdirSync(join(workspaceRoot, "team-template"), { recursive: true });

		expect(() => migrateWorkspace(workspaceRoot)).toThrow(/both group-architecture\/ and team-template\/ exist/);
		expect(readWorkspaceVersion(workspaceRoot)).toBe(1);
	});

	it("migrate CLI reports no-op for current workspaces", async () => {
		const workspaceRoot = createTempDir("d-pi-migrate-current-");
		writeWorkspaceConfig(workspaceRoot, TARGET_WORKSPACE_VERSION);
		const stdout: string[] = [];

		await runDPiCli(["migrate"], {
			cwd: workspaceRoot,
			homeDir: workspaceRoot,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		expect(stdout.join("\n")).toContain(`Workspace already at version ${TARGET_WORKSPACE_VERSION}`);
	});

	it("serve rejects when workspace version is older than the target version", async () => {
		const workspaceRoot = createTempDir("d-pi-serve-old-version-");
		writeWorkspaceConfig(workspaceRoot, 1);
		const start = vi.fn(async () => {});

		await expect(
			runDPiCli(["serve"], {
				cwd: workspaceRoot,
				homeDir: workspaceRoot,
				stdout: () => {},
				stderr: () => {},
				createHub: () => ({ start }),
			}),
		).rejects.toThrow(
			`Workspace version 1 is older than target version ${TARGET_WORKSPACE_VERSION}. Run 'd-pi migrate' before serving.`,
		);
		expect(start).not.toHaveBeenCalled();
	});
});
