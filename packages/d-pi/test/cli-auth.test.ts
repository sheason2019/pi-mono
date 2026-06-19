import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runDPiCli } from "../src/cli-runner.ts";
import type { RunDPiConnectInteractiveModeOptions } from "../src/tui/interactive/run-connect-interactive-mode.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

function createWorkspace(): string {
	const workspaceRoot = createTempDir("d-pi-cli-auth-");
	mkdirSync(join(workspaceRoot, ".dpi"), { recursive: true });
	writeFileSync(join(workspaceRoot, ".dpi", "config.json"), JSON.stringify({ version: 1 }, null, "\t"));
	return workspaceRoot;
}

describe("d-pi auth CLI", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("prints high default ports in help output", async () => {
		const home = createTempDir("d-pi-cli-home-");
		const stdout: string[] = [];

		await runDPiCli(["--help"], {
			cwd: home,
			homeDir: home,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		expect(stdout.join("\n")).toContain("d-pi serve [--port 39090]");
		expect(stdout.join("\n")).not.toContain("d-pi serve [--port 9090]");
	});

	it("creates and lists local users", async () => {
		const home = createTempDir("d-pi-cli-home-");
		const stdout: string[] = [];

		await runDPiCli(["users", "create", "alice", "--description", "Alice laptop"], {
			cwd: home,
			homeDir: home,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});
		await runDPiCli(["users", "list"], {
			cwd: home,
			homeDir: home,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		expect(stdout.join("\n")).toContain("Created local user alice");
		expect(stdout.join("\n")).toContain("Alice laptop");
	});

	it("creates local users without descriptions", async () => {
		const home = createTempDir("d-pi-cli-home-");
		const stdout: string[] = [];

		await runDPiCli(["users", "create", "lixujie"], {
			cwd: home,
			homeDir: home,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		expect(stdout.join("\n")).toContain("Created local user lixujie");
	});

	it("updates and deletes local users", async () => {
		const home = createTempDir("d-pi-cli-home-");
		const stdout: string[] = [];
		const runtime = { cwd: home, homeDir: home, stdout: (line: string) => stdout.push(line), stderr: () => {} };

		await runDPiCli(["users", "create", "alice", "--description", "Alice laptop"], runtime);
		await runDPiCli(["users", "update", "alice", "--description", "Updated laptop"], runtime);
		await runDPiCli(["users", "delete", "alice"], runtime);
		await runDPiCli(["users", "list"], runtime);

		expect(stdout.join("\n")).toContain("Updated local user alice");
		expect(stdout.join("\n")).toContain("Deleted local user alice");
		expect(stdout.join("\n")).not.toContain("alice\tUpdated laptop");
	});

	it("adds and lists allowed users in a workspace", async () => {
		const workspaceRoot = createWorkspace();
		const stdout: string[] = [];

		await runDPiCli(["allow-user", "add", "alice", "--key", "PUB_123", "--description", "Alice laptop allowed"], {
			cwd: workspaceRoot,
			homeDir: workspaceRoot,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});
		await runDPiCli(["allow-user", "list"], {
			cwd: workspaceRoot,
			homeDir: workspaceRoot,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		expect(stdout.join("\n")).toContain("Allowed user alice");
		expect(stdout.join("\n")).toContain("Alice laptop allowed");
	});

	it("adds allowed users without descriptions", async () => {
		const workspaceRoot = createWorkspace();
		const stdout: string[] = [];

		await runDPiCli(["allow-user", "add", "alice", "--key", "PUB_123"], {
			cwd: workspaceRoot,
			homeDir: workspaceRoot,
			stdout: (line) => stdout.push(line),
			stderr: () => {},
		});

		expect(stdout.join("\n")).toContain("Allowed user alice");
	});

	it("updates and removes allowed users in a workspace", async () => {
		const workspaceRoot = createWorkspace();
		const stdout: string[] = [];
		const runtime = {
			cwd: workspaceRoot,
			homeDir: workspaceRoot,
			stdout: (line: string) => stdout.push(line),
			stderr: () => {},
		};

		await runDPiCli(
			["allow-user", "add", "alice", "--key", "PUB_123", "--description", "Alice laptop allowed"],
			runtime,
		);
		await runDPiCli(
			["allow-user", "update", "alice", "--description", "Updated allowed", "--disabled", "true"],
			runtime,
		);
		await runDPiCli(["allow-user", "remove", "alice"], runtime);
		await runDPiCli(["allow-user", "list"], runtime);

		expect(stdout.join("\n")).toContain("Updated allowed user alice");
		expect(stdout.join("\n")).toContain("Removed allowed user alice");
		expect(stdout.join("\n")).not.toContain("alice\tUpdated allowed");
	});

	it("runs _connect-child through the interactive runtime with agent URL and bearer auth", async () => {
		const home = createTempDir("d-pi-cli-home-");
		const calls: RunDPiConnectInteractiveModeOptions[] = [];
		const previousToken = process.env.DPI_AUTH_TOKEN;
		process.env.DPI_AUTH_TOKEN = "session-token";
		try {
			await runDPiCli(["_connect-child", "https://dp.example/agents/root%20agent", "https://dp.example/"], {
				cwd: home,
				homeDir: home,
				stdout: () => {},
				stderr: () => {},
				runConnectInteractiveMode: async (options: RunDPiConnectInteractiveModeOptions) => {
					calls.push(options);
					return {};
				},
			});
		} finally {
			if (previousToken === undefined) {
				delete process.env.DPI_AUTH_TOKEN;
			} else {
				process.env.DPI_AUTH_TOKEN = previousToken;
			}
		}

		expect(calls).toEqual([
			{
				agentUrl: "https://dp.example/agents/root%20agent",
				hubUrl: "https://dp.example/",
				authHeaders: { Authorization: "Bearer session-token" },
			},
		]);
	});

	it("rejects _connect-child without both agentUrl and hubUrl", async () => {
		const home = createTempDir("d-pi-cli-home-");

		await expect(
			runDPiCli(["_connect-child", "https://dp.example/agents/root"], {
				cwd: home,
				homeDir: home,
				stdout: () => {},
				stderr: () => {},
				runConnectInteractiveMode: async () => ({}),
			}),
		).rejects.toThrow("_connect-child requires agentUrl and hubUrl");
	});

	it("keeps cli-runner independent from the interactive runtime connect child", async () => {
		const sourcePath = fileURLToPath(new URL("../src/cli-runner.ts", import.meta.url));
		const source = await readFile(sourcePath, "utf8");

		expect(source).not.toContain("runConnectMode");
	});
});
