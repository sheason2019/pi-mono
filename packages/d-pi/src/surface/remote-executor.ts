export interface DPiRemoteToolRequest {
	requestId: string;
	connectId: string;
	toolName: string;
	params: unknown;
	sourceAgentName?: string;
}

export interface DPiRemoteToolResult {
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface DPiRemoteExecutor {
	executeRemoteTool(request: DPiRemoteToolRequest): Promise<DPiRemoteToolResult>;
}

export function defineDPiRemoteExecutor(executor: DPiRemoteExecutor): DPiRemoteExecutor {
	return executor;
}
