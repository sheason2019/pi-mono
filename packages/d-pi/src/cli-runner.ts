import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { createAllowedUser, listAllowedUsers, removeAllowedUser, updateAllowedUser } from "./auth/allowed-users.ts";
import { createLocalUser, listLocalUsers, removeLocalUser, updateLocalUser } from "./auth/local-users.ts";
import { runDPiConnectMode } from "./connect/connect-mode.ts";
import { DEFAULT_HUB_PORT } from "./defaults.ts";
import { main as runExecutor } from "./executor/index.ts";
import { Hub } from "./hub/hub.ts";
import {
	type RunDPiConnectInteractiveModeOptions,
	runDPiConnectInteractiveMode,
} from "./tui/interactive/run-connect-interactive-mode.ts";
import type { RunDPiRemoteTuiOptions } from "./tui/remote-tui.ts";
import type { HubConfig } from "./types.ts";
import { initWorkspace, isWorkspaceRoot, loadWorkspaceContext } from "./workspace/workspace.ts";

let cachedVersion: string | null = null;

function getVersion(): string {
	if (cachedVersion === null) {
		const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
		cachedVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
	}
	return cachedVersion;
}

export interface DPiCliRuntime {
	cwd: string;
	homeDir: string;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	createHub?: (config: HubConfig) => { start(): Promise<void> };
	cloneTeamTemplate?: (repo: string, targetDir: string) => Promise<void>;
	runRemoteTui?: (options: RunDPiRemoteTuiOptions) => Promise<unknown>;
	runConnectInteractiveMode?: (options: RunDPiConnectInteractiveModeOptions) => Promise<unknown>;
}

function defaultRuntime(): DPiCliRuntime {
	return {
		cwd: process.cwd(),
		homeDir: homedir(),
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	};
}

function localUsersRoot(runtime: DPiCliRuntime): string {
	return join(runtime.homeDir, ".d-pi");
}

function defaultCloneTeamTemplate(repo: string, targetDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("git", ["clone", repo, targetDir], (error, _stdout, stderr) => {
			if (error) {
				const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
				reject(new Error(`Failed to clone team template${suffix}`));
				return;
			}
			resolve();
		});
	});
}

function buildProgram(runtime: DPiCliRuntime): Command {
	const program = new Command();

	program
		.name("d-pi")
		.description("Multi-agent tree orchestrator")
		.version(getVersion())
		.exitOverride()
		.configureOutput({
			writeOut: (str) => runtime.stdout(str.replace(/\n$/, "")),
			writeErr: (str) => runtime.stderr(str.replace(/\n$/, "")),
			outputError: (str, write) => write(str),
		});

	program
		.command("init")
		.description("Initialize a workspace in the current directory")
		.option("--team-template <git-repo>", "Clone a team template repository")
		.action(async (options: { teamTemplate?: string }) => {
			initWorkspace(runtime.cwd);
			if (options.teamTemplate) {
				const targetDir = join(runtime.cwd, "team-template");
				const cloneTeamTemplate = runtime.cloneTeamTemplate ?? defaultCloneTeamTemplate;
				await cloneTeamTemplate(options.teamTemplate, targetDir);
				runtime.stdout(`[d-pi] Cloned team template from ${options.teamTemplate} into team-template/`);
			}
			runtime.stdout("[d-pi] Workspace initialized in current directory");
			runtime.stdout("[d-pi]   AGENTS.md               — shared context for all agents");
			runtime.stdout("[d-pi]   APPEND_SYSTEM.md        — shared system prompt for all agents");
			runtime.stdout("[d-pi]   agents/root/            — root agent working directory");
			runtime.stdout("[d-pi]   agents/root/agent.ts    — root agent definition");
			runtime.stdout("[d-pi]   agents/root/AGENTS.md   — root agent specific context");
			runtime.stdout("[d-pi]   agents/root/.pi/APPEND_SYSTEM.md — root agent system prompt");
			runtime.stdout("[d-pi] Run 'd-pi serve' to start the hub.");
		});

	program
		.command("serve")
		.description("Start the hub (must be in a workspace)")
		.option("--port <port>", "Port to listen on", String(DEFAULT_HUB_PORT))
		.action(async (options: { port: string }) => {
			if (!isWorkspaceRoot(runtime.cwd)) {
				throw new Error("[d-pi] Not a d-pi workspace. Run 'd-pi init' first.");
			}
			const workspaceContext = loadWorkspaceContext(runtime.cwd);
			const port = parseInt(options.port, 10);
			const createHub = runtime.createHub ?? ((config: HubConfig) => new Hub(config));
			const hub = createHub({
				port,
				cwd: runtime.cwd,
				workspaceRoot: runtime.cwd,
				workspaceContext,
			});
			await hub.start();
		});

	program
		.command("connect")
		.description("Connect to a running d-pi hub")
		.argument("[target]", "Target URL or user@url", `http://localhost:${DEFAULT_HUB_PORT}`)
		.option("--agent <id|name>", "Connect to a specific agent")
		.action(async (target: string, options: { agent?: string }) => {
			const url = target;
			await runDPiConnectMode({ url, agent: options.agent });
		});

	const users = program.command("users").description("Manage local users");

	users
		.command("create")
		.description("Create a local user")
		.argument("<name>", "User name")
		.option("--description <text>", "User description", "")
		.action((name: string, options: { description: string }) => {
			const user = createLocalUser(localUsersRoot(runtime), { name, description: options.description });
			runtime.stdout(`Created local user ${user.name}`);
			runtime.stdout(`description: ${user.description}`);
			runtime.stdout(`publicKey: ${user.publicKey}`);
		});

	users
		.command("list")
		.description("List local users")
		.action(() => {
			const userList = listLocalUsers(localUsersRoot(runtime));
			for (const user of userList) {
				runtime.stdout(`${user.name}\t${user.description}\t${user.publicKey}`);
			}
		});

	users
		.command("update")
		.description("Update a local user")
		.argument("<name>", "User name")
		.option("--description <text>", "User description")
		.action((name: string, options: { description?: string }) => {
			const user = updateLocalUser(localUsersRoot(runtime), name, { description: options.description });
			runtime.stdout(`Updated local user ${user.name}`);
		});

	users
		.command("delete")
		.description("Delete a local user")
		.argument("<name>", "User name")
		.action((name: string) => {
			removeLocalUser(localUsersRoot(runtime), name);
			runtime.stdout(`Deleted local user ${name}`);
		});

	const allowUser = program.command("allow-user").description("Manage allowed users in a workspace");

	allowUser
		.command("add")
		.description("Add an allowed user")
		.argument("<name>", "User name")
		.requiredOption("--key <publicKey>", "Public key")
		.option("--description <text>", "User description", "")
		.action((name: string, options: { key: string; description: string }) => {
			if (!isWorkspaceRoot(runtime.cwd)) {
				throw new Error("allow-user commands must be run from a d-pi workspace root");
			}
			const user = createAllowedUser(runtime.cwd, {
				name,
				publicKey: options.key,
				description: options.description,
			});
			runtime.stdout(`Allowed user ${user.name}`);
			runtime.stdout(`description: ${user.description}`);
			runtime.stdout(`publicKey: ${user.publicKey}`);
		});

	allowUser
		.command("list")
		.description("List allowed users")
		.action(() => {
			if (!isWorkspaceRoot(runtime.cwd)) {
				throw new Error("allow-user commands must be run from a d-pi workspace root");
			}
			const userList = listAllowedUsers(runtime.cwd);
			for (const user of userList) {
				runtime.stdout(`${user.name}\t${user.description}\t${user.publicKey}`);
			}
		});

	allowUser
		.command("update")
		.description("Update an allowed user")
		.argument("<name>", "User name")
		.option("--key <publicKey>", "Public key")
		.option("--description <text>", "User description")
		.option("--disabled <boolean>", "Disable the user", (val: string) => {
			if (val === "true") return true;
			if (val === "false") return false;
			throw new Error("--disabled must be true or false");
		})
		.action((name: string, options: { key?: string; description?: string; disabled?: boolean }) => {
			if (!isWorkspaceRoot(runtime.cwd)) {
				throw new Error("allow-user commands must be run from a d-pi workspace root");
			}
			const user = updateAllowedUser(runtime.cwd, name, {
				description: options.description,
				publicKey: options.key,
				disabled: options.disabled,
			});
			runtime.stdout(`Updated allowed user ${user.name}`);
		});

	allowUser
		.command("remove")
		.description("Remove an allowed user")
		.argument("<name>", "User name")
		.action((name: string) => {
			if (!isWorkspaceRoot(runtime.cwd)) {
				throw new Error("allow-user commands must be run from a d-pi workspace root");
			}
			removeAllowedUser(runtime.cwd, name);
			runtime.stdout(`Removed allowed user ${name}`);
		});

	program
		.command("_connect-child", { hidden: true })
		.description("Internal command for child process")
		.argument("<agentUrl>", "Agent URL")
		.argument("<hubUrl>", "Hub URL")
		.action(async (agentUrl: string, hubUrl: string) => {
			const authToken = process.env.DPI_AUTH_TOKEN;
			const runInteractiveMode = runtime.runConnectInteractiveMode ?? runDPiConnectInteractiveMode;
			await runInteractiveMode({
				agentUrl,
				hubUrl,
				...(authToken ? { authHeaders: { Authorization: `Bearer ${authToken}` } } : {}),
			});
		});

	program
		.command("_executor-child", { hidden: true })
		.description("Internal command for child process")
		.action(async () => {
			await runExecutor();
		});

	return program;
}

export async function runDPiCli(args: string[], runtime: DPiCliRuntime = defaultRuntime()): Promise<void> {
	const program = buildProgram(runtime);
	try {
		await program.parseAsync(args, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) {
			if (
				error.code === "commander.helpDisplayed" ||
				error.code === "commander.version" ||
				error.code === "commander.help"
			) {
				return;
			}
			throw new Error(error.message);
		}
		throw error;
	}
}
