import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TeamTemplateDefinition } from "./workspace-definition.ts";

const TEAM_TEMPLATE_DIR = "team-template";

export interface TeamTemplateSyncResult {
	action: "cloned" | "updated" | "removed" | "unchanged";
	repo?: string;
	ref?: string;
	commit?: string;
}

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			if (error) {
				const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
				reject(new Error(`git ${args[0]} failed${suffix}`));
				return;
			}
			resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

async function getRemoteUrl(dir: string): Promise<string | undefined> {
	try {
		const { stdout } = await git(["remote", "get-url", "origin"], dir);
		return stdout || undefined;
	} catch {
		return undefined;
	}
}

async function getCurrentCommit(dir: string): Promise<string | undefined> {
	try {
		const { stdout } = await git(["rev-parse", "HEAD"], dir);
		return stdout || undefined;
	} catch {
		return undefined;
	}
}

async function cloneRepo(repo: string, targetDir: string, ref?: string): Promise<void> {
	const args = ["clone", repo, targetDir];
	if (ref) {
		args.splice(1, 0, "--branch", ref);
	}
	await new Promise<void>((resolve, reject) => {
		execFile("git", args, (error, _stdout, stderr) => {
			if (error) {
				const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
				reject(new Error(`Failed to clone team template${suffix}`));
				return;
			}
			resolve();
		});
	});
}

async function fetchAndCheckout(dir: string, ref?: string): Promise<{ commit: string }> {
	await git(["fetch", "--all", "--prune"], dir);
	if (ref) {
		await git(["checkout", ref], dir);
	} else {
		await git(["reset", "--hard", "origin/HEAD"], dir);
	}
	const { stdout } = await git(["rev-parse", "HEAD"], dir);
	return { commit: stdout };
}

export async function syncTeamTemplate(
	workspaceRoot: string,
	declared: TeamTemplateDefinition | undefined,
): Promise<TeamTemplateSyncResult> {
	const targetDir = join(workspaceRoot, TEAM_TEMPLATE_DIR);
	const dirExists = existsSync(targetDir);
	const gitDirExists = dirExists && existsSync(join(targetDir, ".git"));

	if (!declared) {
		if (dirExists) {
			await rm(targetDir, { recursive: true, force: true });
			return { action: "removed" };
		}
		return { action: "unchanged" };
	}

	const { repo, ref } = declared;

	if (!dirExists || !gitDirExists) {
		if (dirExists) {
			await rm(targetDir, { recursive: true, force: true });
		}
		await cloneRepo(repo, targetDir, ref);
		const commit = await getCurrentCommit(targetDir);
		return { action: "cloned", repo, ref, commit };
	}

	const currentRemote = await getRemoteUrl(targetDir);
	if (currentRemote !== repo) {
		await rm(targetDir, { recursive: true, force: true });
		await cloneRepo(repo, targetDir, ref);
		const commit = await getCurrentCommit(targetDir);
		return { action: "cloned", repo, ref, commit };
	}

	const beforeCommit = await getCurrentCommit(targetDir);
	const { commit } = await fetchAndCheckout(targetDir, ref);
	if (commit !== beforeCommit) {
		return { action: "updated", repo, ref, commit };
	}

	return { action: "unchanged", repo, ref, commit };
}
