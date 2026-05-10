import { existsSync } from "node:fs";
import { VERSION } from "../config.js";
import { getHubModelsConfigPaths } from "../models-config.js";
import { DISABLED_SESSION_COMMAND_NAMES } from "../session/hub-session-service.js";
import { HUB_PROTOCOL_VERSION } from "../transport/protocol.js";
import { getWorkspaceStatus } from "../workspace.js";

export function runStatus(cwd: string = process.cwd()): number {
	const status = getWorkspaceStatus(cwd);
	const modelsConfigPaths = getHubModelsConfigPaths(cwd);
	const modelsConfigSources = [modelsConfigPaths.globalModelsFile, modelsConfigPaths.localModelsFile].filter((path) =>
		existsSync(path),
	);

	console.log(`Hub version: ${VERSION}`);
	console.log(`Protocol version: ${HUB_PROTOCOL_VERSION}`);
	console.log(`Workspace: ${status.paths.workspaceDir}`);
	console.log(`Initialized: ${status.initialized ? "yes" : "no"}`);
	console.log(`Session file: ${status.paths.sessionFile}`);
	console.log(`Merged models file: ${modelsConfigPaths.mergedModelsFile}`);
	console.log(`Models config sources: ${modelsConfigSources.length > 0 ? modelsConfigSources.join(", ") : "(none)"}`);
	console.log(`Disabled session commands: ${DISABLED_SESSION_COMMAND_NAMES.map((name) => `/${name}`).join(", ")}`);

	if (status.header) {
		console.log(`Session ID: ${status.header.id}`);
		console.log(`Session cwd: ${status.header.cwd}`);
		console.log(`Created: ${status.header.timestamp}`);
	}

	return status.initialized ? 0 : 1;
}
