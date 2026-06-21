import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runConnectMode } from "@sheason/pi-coding-agent/d-pi-worker";
import { createAllowedUser, listAllowedUsers, removeAllowedUser, updateAllowedUser } from "./auth/allowed-users.ts";
import { createLocalUser, listLocalUsers, removeLocalUser, updateLocalUser } from "./auth/local-users.ts";
import { runDPiConnectMode } from "./connect/connect-mode.ts";
import { DEFAULT_HUB_PORT } from "./defaults.ts";
import { main as runExecutor } from "./executor/index.ts";
import { Hub } from "./hub/hub.ts";
import type { HubConfig } from "./types.ts";
import {
	initWorkspace,
	isWorkspaceRoot,
	loadWorkspaceContext,
	migrateWorkspace,
	TARGET_WORKSPACE_VERSION,
	validateWorkspace,
} from "./workspace/workspace.ts";

const dPiClientExtensionPath = new URL(
	`./extension/client-extension${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
	import.meta.url,
).pathname;

export interface DPiCliRuntime {
	cwd: string;
	homeDir: string;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	createHub?: (config: HubConfig) => { start(): Promise<void> };
	cloneTeamTemplate?: (repo: string, targetDir: string) => Promise<void>;
}

function defaultRuntime(): DPiCliRuntime {
	return {
		cwd: process.cwd(),
		homeDir: homedir(),
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	};
}

function optionValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function hasOption(args: string[], name: string): boolean {
	return args.includes(name);
}

function optionBoolean(args: string[], name: string): boolean | undefined {
	const value = optionValue(args, name);
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
}

function localUsersRoot(runtime: DPiCliRuntime): string {
	return join(runtime.homeDir, ".d-pi");
}

function printHelp(runtime: DPiCliRuntime): void {
	runtime.stdout(`d-pi - Multi-agent tree orchestrator

Usage:
  d-pi init [--team-template <git-repo>]  Initialize a workspace in the current directory
  d-pi migrate                      Migrate the current workspace to the latest schema
  d-pi serve [--port ${DEFAULT_HUB_PORT}] [--model <model>]  Start the hub (must be in a workspace)
  d-pi connect <user@url> [--agent <id|name>]
  d-pi users create <name> [--description <text>]
  d-pi users update <name> [--description <text>]
  d-pi users delete <name>
  d-pi users list
  d-pi allow-user add <name> --key <publicKey> [--description <text>]
  d-pi allow-user update <name> [--key <publicKey>] [--description <text>] [--disabled true|false]
  d-pi allow-user remove <name>
  d-pi allow-user list
`);
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

async function handleUsers(args: string[], runtime: DPiCliRuntime): Promise<void> {
	const subcommand = args[1];
	if (subcommand === "create") {
		const name = args[2];
		if (!name) throw new Error("Missing local user name");
		const description = optionValue(args, "--description") ?? "";
		const user = createLocalUser(localUsersRoot(runtime), { name, description });
		runtime.stdout(`Created local user ${user.name}`);
		runtime.stdout(`description: ${user.description}`);
		runtime.stdout(`publicKey: ${user.publicKey}`);
		return;
	}
	if (subcommand === "list") {
		const users = listLocalUsers(localUsersRoot(runtime));
		for (const user of users) {
			runtime.stdout(`${user.name}\t${user.description}\t${user.publicKey}`);
		}
		return;
	}
	if (subcommand === "update") {
		const name = args[2];
		if (!name) throw new Error("Missing local user name");
		const user = updateLocalUser(localUsersRoot(runtime), name, { description: optionValue(args, "--description") });
		runtime.stdout(`Updated local user ${user.name}`);
		return;
	}
	if (subcommand === "delete") {
		const name = args[2];
		if (!name) throw new Error("Missing local user name");
		removeLocalUser(localUsersRoot(runtime), name);
		runtime.stdout(`Deleted local user ${name}`);
		return;
	}
	throw new Error("Unknown users command");
}

async function handleAllowUser(args: string[], runtime: DPiCliRuntime): Promise<void> {
	if (!isWorkspaceRoot(runtime.cwd)) {
		throw new Error("allow-user commands must be run from a d-pi workspace root");
	}
	const subcommand = args[1];
	if (subcommand === "add") {
		const name = args[2];
		if (!name) throw new Error("Missing allowed user name");
		const publicKey = optionValue(args, "--key") ?? "";
		const description = optionValue(args, "--description") ?? "";
		const user = createAllowedUser(runtime.cwd, { name, publicKey, description });
		runtime.stdout(`Allowed user ${user.name}`);
		runtime.stdout(`description: ${user.description}`);
		runtime.stdout(`publicKey: ${user.publicKey}`);
		return;
	}
	if (subcommand === "list") {
		const users = listAllowedUsers(runtime.cwd);
		for (const user of users) {
			runtime.stdout(`${user.name}\t${user.description}\t${user.publicKey}`);
		}
		return;
	}
	if (subcommand === "update") {
		const name = args[2];
		if (!name) throw new Error("Missing allowed user name");
		const user = updateAllowedUser(runtime.cwd, name, {
			description: optionValue(args, "--description"),
			publicKey: optionValue(args, "--key"),
			disabled: optionBoolean(args, "--disabled"),
		});
		runtime.stdout(`Updated allowed user ${user.name}`);
		return;
	}
	if (subcommand === "remove") {
		const name = args[2];
		if (!name) throw new Error("Missing allowed user name");
		removeAllowedUser(runtime.cwd, name);
		runtime.stdout(`Removed allowed user ${name}`);
		return;
	}
	throw new Error("Unknown allow-user command");
}

export async function runDPiCli(args: string[], runtime: DPiCliRuntime = defaultRuntime()): Promise<void> {
	const command = args[0];
	if (command === "init") {
		const teamTemplateRepo = optionValue(args, "--team-template");
		if (hasOption(args, "--team-template") && !teamTemplateRepo) {
			throw new Error("--team-template requires a git repository URL");
		}
		initWorkspace(runtime.cwd);
		if (teamTemplateRepo) {
			const targetDir = join(runtime.cwd, "team-template");
			const cloneTeamTemplate = runtime.cloneTeamTemplate ?? defaultCloneTeamTemplate;
			await cloneTeamTemplate(teamTemplateRepo, targetDir);
			runtime.stdout(`[d-pi] Cloned team template from ${teamTemplateRepo} into team-template/`);
		}
		runtime.stdout("[d-pi] Workspace initialized in current directory");
		runtime.stdout("[d-pi]   .dpi/config.json        — workspace configuration");
		runtime.stdout("[d-pi]   AGENTS.md               — shared context for all agents");
		runtime.stdout("[d-pi]   APPEND_SYSTEM.md        — shared system prompt for all agents");
		runtime.stdout("[d-pi]   agents/root/            — root agent working directory");
		runtime.stdout("[d-pi]   agents/root/agent.ts    — root agent definition");
		runtime.stdout("[d-pi]   agents/root/AGENTS.md   — root agent specific context");
		runtime.stdout("[d-pi]   agents/root/.pi/APPEND_SYSTEM.md — root agent system prompt");
		runtime.stdout("[d-pi] Run 'd-pi serve' to start the hub.");
		return;
	}
	if (command === "migrate") {
		if (!isWorkspaceRoot(runtime.cwd)) {
			throw new Error("[d-pi] Not a d-pi workspace. Run 'd-pi init' first.");
		}
		const result = migrateWorkspace(runtime.cwd);
		if (result.fromVersion === result.toVersion) {
			runtime.stdout(`[d-pi] Workspace already at version ${result.toVersion}; no migration needed.`);
			return;
		}
		runtime.stdout(`[d-pi] Migrated workspace from version ${result.fromVersion} to ${result.toVersion}.`);
		if (result.renamedGroupArchitecture) {
			runtime.stdout("[d-pi] Renamed group-architecture/ to team-template/.");
		}
		return;
	}
	if (command === "users") {
		await handleUsers(args, runtime);
		return;
	}
	if (command === "allow-user") {
		await handleAllowUser(args, runtime);
		return;
	}
	if (command === "serve") {
		if (!isWorkspaceRoot(runtime.cwd)) {
			throw new Error("[d-pi] Not a d-pi workspace. Run 'd-pi init' first.");
		}
		const workspaceConfig = validateWorkspace(runtime.cwd);
		if (workspaceConfig.version !== TARGET_WORKSPACE_VERSION) {
			throw new Error(
				`[d-pi] Workspace version ${workspaceConfig.version} is older than target version ${TARGET_WORKSPACE_VERSION}. Run 'd-pi migrate' before serving.`,
			);
		}
		const workspaceContext = loadWorkspaceContext(runtime.cwd);
		const portValue = optionValue(args, "--port");
		const port = portValue ? parseInt(portValue, 10) : DEFAULT_HUB_PORT;
		const model = optionValue(args, "--model");
		const createHub = runtime.createHub ?? ((config: HubConfig) => new Hub(config));
		const hub = createHub({
			port,
			cwd: runtime.cwd,
			model: model ?? undefined,
			workspaceRoot: runtime.cwd,
			workspaceContext,
			workspaceConfig,
		});
		await hub.start();
		return;
	}
	if (command === "connect") {
		const target = args[1];
		const url = target ?? optionValue(args, "--url") ?? `http://localhost:${DEFAULT_HUB_PORT}`;
		const agent = optionValue(args, "--agent");
		await runDPiConnectMode({ url, agent });
		return;
	}
	if (command === "_connect-child") {
		const agentUrl = args[1];
		await runConnectMode({
			url: agentUrl,
			authToken: process.env.DPI_AUTH_TOKEN,
			clientExtensionPaths: [dPiClientExtensionPath],
			clientExtensionCwd: dirname(dPiClientExtensionPath),
		});
		return;
	}
	if (command === "_executor-child") {
		await runExecutor();
		return;
	}
	printHelp(runtime);
}
