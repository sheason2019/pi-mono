import { join } from "node:path";

export const APP_NAME = "d-pi hub";
export { VERSION } from "../version.js";
export const WORKSPACE_DIR_NAME = ".pi-hub";
export const CHILD_AGENT_DIR_NAME = ".child-agent";
/** Local pi workspace metadata directory (distinct from hub session dir `.pi-hub`). */
export const LOCAL_PI_DIR_NAME = ".pi";
export const SOURCES_CONFIG_FILE_NAME = "sources.json";
export const AGENTS_CONFIG_FILE_NAME = "agents.json";
export const AUTH_CONFIG_FILE_NAME = "auth.json";
export const SESSION_FILE_NAME = "session.jsonl";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

export function getWorkspaceDir(cwd: string): string {
	return join(cwd, WORKSPACE_DIR_NAME);
}

export function getLocalPiDir(cwd: string): string {
	return join(cwd, LOCAL_PI_DIR_NAME);
}

export function getSourcesConfigPath(cwd: string): string {
	return join(getLocalPiDir(cwd), SOURCES_CONFIG_FILE_NAME);
}

export function getAgentsConfigPath(cwd: string): string {
	return join(getLocalPiDir(cwd), AGENTS_CONFIG_FILE_NAME);
}

export function getAuthConfigPath(cwd: string): string {
	return join(getLocalPiDir(cwd), AUTH_CONFIG_FILE_NAME);
}

export function getSessionFile(cwd: string): string {
	return join(getWorkspaceDir(cwd), SESSION_FILE_NAME);
}

export function getListenHost(): string {
	return process.env.PI_HUB_HOST?.trim() || DEFAULT_HOST;
}

export function getListenPort(): number {
	const rawPort = process.env.PI_HUB_PORT?.trim();
	if (!rawPort) {
		return DEFAULT_PORT;
	}

	const parsedPort = Number.parseInt(rawPort, 10);
	if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
		throw new Error(`Invalid PI_HUB_PORT value: ${rawPort}`);
	}
	return parsedPort;
}
