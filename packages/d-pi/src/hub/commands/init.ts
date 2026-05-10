import { AgentRegistry } from "../agents/agent-registry.js";
import { HubAuthTokenStore } from "../auth/token-store.js";
import { initializeWorkspace } from "../workspace.js";

export function runInit(cwd: string = process.cwd()): number {
	const result = initializeWorkspace(cwd);
	AgentRegistry.open(cwd);
	const rootToken = HubAuthTokenStore.open(cwd).ensureRootToken().token;
	const verb = result.created ? "Initialized" : "Already initialized";

	console.log(`${verb} D-Pi hub workspace`);
	console.log(`Workspace: ${result.paths.workspaceDir}`);
	console.log(`Session: ${result.paths.sessionFile}`);
	console.log(`Session ID: ${result.header.id}`);
	if (rootToken) {
		console.log(`Root token: ${rootToken}`);
		console.log("Root token is shown once; store it securely.");
	}
	return 0;
}
