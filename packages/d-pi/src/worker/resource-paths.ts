import { ensureAgentTuiComponentsClientCapability } from "../tui-components/client-capability.ts";

export interface WorkerAdditionalExtensionPathsOptions {
	agentCwd: string;
	dPiClientExtensionPath: string;
	workspaceAdditionalExtensionPaths: string[];
}

export function buildWorkerAdditionalExtensionPaths(options: WorkerAdditionalExtensionPathsOptions): string[] {
	const tuiComponentsCapabilityPath = ensureAgentTuiComponentsClientCapability(options.agentCwd);
	return [options.dPiClientExtensionPath, tuiComponentsCapabilityPath, ...options.workspaceAdditionalExtensionPaths];
}
