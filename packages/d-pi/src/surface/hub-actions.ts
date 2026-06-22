export type DPiHubMessageMode = "next" | "steer";

export type DPiAgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

export interface DPiTeamAgentEntry {
	name: string;
	parentName: string | undefined;
	status: DPiAgentStatus;
	children: string[];
}

export interface DPiTeamExecutorEntry {
	connectId: string;
	cwd: string;
	attached: boolean;
	boundAgentName: string | undefined;
}

export interface DPiTeamSnapshot {
	agents: DPiTeamAgentEntry[];
	executors: DPiTeamExecutorEntry[];
	rootName: string;
}

export interface DPiCreateAgentActionPayload {
	name: string;
	cwd?: string;
}

export interface DPiCreateAgentActionResult {
	agentName: string;
	agentId?: string;
}

export interface DPiDestroyAgentActionPayload {
	agentName: string;
}

export interface DPiSendMessageActionPayload {
	fromAgentName: string;
	toAgentName: string;
	content: string;
	mode?: DPiHubMessageMode;
	sourceName?: string;
}

export interface DPiSourceInfo {
	name: string;
	status: "running" | "stopped" | "error";
	subscribers: string[];
	restartCount: number;
}

export interface DPiDispatchRemoteToolActionPayload {
	requestId: string;
	connectId: string;
	toolName: string;
	params: unknown;
	sourceAgentName?: string;
}

export interface DPiDispatchRemoteToolActionResult {
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export type DPiHubActionRequest =
	| { action: "createAgent"; payload: DPiCreateAgentActionPayload }
	| { action: "destroyAgent"; payload: DPiDestroyAgentActionPayload }
	| { action: "getTeam"; payload: Record<string, never> }
	| { action: "sendMessage"; payload: DPiSendMessageActionPayload }
	| { action: "dispatchRemoteTool"; payload: DPiDispatchRemoteToolActionPayload };

export type DPiHubActionsTransport = (request: DPiHubActionRequest) => Promise<unknown>;

export interface DPiHubActionsClient {
	createAgent(payload: DPiCreateAgentActionPayload): Promise<DPiCreateAgentActionResult>;
	destroyAgent(payload: DPiDestroyAgentActionPayload): Promise<{ ok: boolean; error?: string }>;
	getTeam(): Promise<DPiTeamSnapshot>;
	sendMessage(payload: DPiSendMessageActionPayload): Promise<{ ok: boolean; error?: string }>;
	dispatchRemoteTool(payload: DPiDispatchRemoteToolActionPayload): Promise<DPiDispatchRemoteToolActionResult>;
}

async function dispatchHubAction<TResult>(
	transport: DPiHubActionsTransport,
	request: DPiHubActionRequest,
): Promise<TResult> {
	return (await transport(request)) as TResult;
}

export function createDPiHubActionsClient(transport: DPiHubActionsTransport): DPiHubActionsClient {
	return {
		createAgent(payload) {
			return dispatchHubAction(transport, { action: "createAgent", payload });
		},
		destroyAgent(payload) {
			return dispatchHubAction(transport, { action: "destroyAgent", payload });
		},
		getTeam() {
			return dispatchHubAction(transport, { action: "getTeam", payload: {} });
		},
		sendMessage(payload) {
			return dispatchHubAction(transport, { action: "sendMessage", payload });
		},
		dispatchRemoteTool(payload) {
			return dispatchHubAction(transport, { action: "dispatchRemoteTool", payload });
		},
	};
}
