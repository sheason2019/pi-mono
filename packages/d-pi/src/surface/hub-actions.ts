export type DPiHubMessageMode = "next" | "steer";

export type DPiAgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

export interface DPiTeamAgentEntry {
	name: string;
	parentName: string | undefined;
	status: DPiAgentStatus;
	children: string[];
	cwd: string;
	description?: string;
	model?: string;
	sources?: string[];
	toolCount?: number;
	customToolCount?: number;
	commandCount?: number;
	contextFileCount?: number;
	hasSkillsDir?: boolean;
	hasToolsDir?: boolean;
	hasCommandsDir?: boolean;
	disableDefaultTools?: boolean;
	error?: string;
}

export interface DPiTeamSourceEntry {
	name: string;
	running: boolean;
	subscribers: string[];
	command: string;
	description?: string;
	filePath: string;
	messageCount: number;
	lastMessageTime: number | undefined;
}

export interface DPiTeamExecutorEntry {
	connectId: string;
	cwd: string;
	attached: boolean;
	boundAgentName: string | undefined;
}

export interface DPiTeamSnapshot {
	agents: DPiTeamAgentEntry[];
	sources: DPiTeamSourceEntry[];
	executors: DPiTeamExecutorEntry[];
	rootName: string;
}

export interface DPiCreateAgentActionPayload {
	name: string;
	cwd?: string;
}

export interface DPiCreateAgentActionResult {
	agentName: string;
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

export interface DPiReloadWorkspaceResult {
	models: string[];
	contextFiles: string[];
	sources: {
		added: string[];
		removed: string[];
		changed: string[];
		total: number;
	};
}

export interface DPiSyncAgentsResult {
	added: string[];
	removed: string[];
	errors: Array<{ agentName: string; error: string }>;
}

export type DPiHubActionRequest =
	| { action: "createAgent"; payload: DPiCreateAgentActionPayload }
	| { action: "destroyAgent"; payload: DPiDestroyAgentActionPayload }
	| { action: "getTeam"; payload: Record<string, never> }
	| { action: "sendMessage"; payload: DPiSendMessageActionPayload }
	| { action: "reloadWorkspace"; payload: Record<string, never> }
	| { action: "syncAgents"; payload: Record<string, never> }
	| { action: "dispatchRemoteTool"; payload: DPiDispatchRemoteToolActionPayload };

export type DPiHubActionsTransport = (request: DPiHubActionRequest) => Promise<unknown>;

export interface DPiHubActionsClient {
	createAgent(payload: DPiCreateAgentActionPayload): Promise<DPiCreateAgentActionResult>;
	destroyAgent(payload: DPiDestroyAgentActionPayload): Promise<{ ok: boolean; error?: string }>;
	getTeam(): Promise<DPiTeamSnapshot>;
	sendMessage(payload: DPiSendMessageActionPayload): Promise<{ ok: boolean; error?: string }>;
	reloadWorkspace(): Promise<DPiReloadWorkspaceResult>;
	syncAgents(): Promise<DPiSyncAgentsResult>;
	dispatchRemoteTool(payload: DPiDispatchRemoteToolActionPayload): Promise<DPiDispatchRemoteToolActionResult>;
}

async function dispatchHubAction<TResult>(
	transport: DPiHubActionsTransport,
	request: DPiHubActionRequest,
): Promise<TResult> {
	return (await transport(request)) as TResult;
}

export function createHubActionsClient(transport: DPiHubActionsTransport): DPiHubActionsClient {
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
		reloadWorkspace() {
			return dispatchHubAction(transport, { action: "reloadWorkspace", payload: {} });
		},
		syncAgents() {
			return dispatchHubAction(transport, { action: "syncAgents", payload: {} });
		},
		dispatchRemoteTool(payload) {
			return dispatchHubAction(transport, { action: "dispatchRemoteTool", payload });
		},
	};
}
