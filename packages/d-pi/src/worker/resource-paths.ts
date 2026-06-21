import { ensureAgentTuiComponentsClientCapability } from "../tui-components/client-capability.ts";

export interface WorkerAdditionalExtensionPathsOptions {
	agentCwd: string;
	workspaceRoot: string | undefined;
	workspaceAdditionalExtensionPaths: string[];
}

export function buildWorkerAdditionalExtensionPaths(options: WorkerAdditionalExtensionPathsOptions): string[] {
	const tuiComponentsCapabilityPath = ensureAgentTuiComponentsClientCapability(options.agentCwd, {
		workspaceRoot: options.workspaceRoot,
	});
	return [tuiComponentsCapabilityPath, ...options.workspaceAdditionalExtensionPaths];
}
