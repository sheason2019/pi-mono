import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CHILD_AGENT_DIR_NAME, SESSION_FILE_NAME } from "../config.js";
import { assertSafeAgentId } from "../workspace.js";

export function getChildAgentsDir(cwd: string): string {
	return join(cwd, CHILD_AGENT_DIR_NAME);
}

export function getChildAgentDir(cwd: string, agentId: string): string {
	assertSafeAgentId(agentId);
	return join(getChildAgentsDir(cwd), agentId);
}

export function getChildAgentSessionFile(cwd: string, agentId: string): string {
	return join(getChildAgentDir(cwd, agentId), SESSION_FILE_NAME);
}

export function getChildAgentMcpConfigPath(cwd: string, agentId: string): string {
	return join(getChildAgentDir(cwd, agentId), "mcp.json");
}

export function getChildAgentSourcesConfigPath(cwd: string, agentId: string): string {
	return join(getChildAgentDir(cwd, agentId), "sources.json");
}

export function initializeChildAgentDirectory(cwd: string, agentId: string): string {
	const dir = getChildAgentDir(cwd, agentId);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, "skills"), { recursive: true });
	mkdirSync(join(dir, "prompts"), { recursive: true });
	return dir;
}
