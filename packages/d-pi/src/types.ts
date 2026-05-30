// === Agent Status ===
export type AgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

// === Agent Config (persisted as agent.json in each agent's cwd) ===
export interface AgentConfig {
	name: string;
	parentName: string | undefined;
	model?: string;
	sessionId?: string;
}

// === Workspace Configuration ===
export interface WorkspaceConfig {
	version: 1;
	defaultModel?: string;
}

export interface WorkspaceContext {
	workspaceRoot: string;
	appendSystemPrompt?: string;
	additionalSkillPaths: string[];
	additionalExtensionPaths: string[];
}

// === Worker Configuration (passed via workerData) ===
export interface AgentWorkerConfig {
	agentId: string;
	port: number;
	cwd: string;
	model?: string;
	parentAgentId?: string;
	agentName: string;
	workspaceContext?: WorkspaceContext;
	sessionId?: string;
	sessionDir?: string;
}

// === Worker → Hub IPC Messages ===
export type WorkerToHubMessage =
	| { type: "ready"; agentId: string; port: number }
	| { type: "error"; agentId: string; error: string }
	| { type: "tool_call"; agentId: string; tool: string; params: unknown; callId: string }
	| { type: "tool_call_timeout"; agentId: string; callId: string }
	| { type: "status_update"; agentId: string; status: AgentStatus };

// === Hub → Worker IPC Messages ===
export type HubToWorkerMessage =
	| { type: "tool_result"; callId: string; result: unknown }
	| { type: "message"; fromAgentId: string; content: string; sourceName?: string }
	| { type: "destroy" };

// === Agent Network Snapshot ===
export interface AgentNetworkEntry {
	id: string;
	name: string;
	parentId: string | undefined;
	status: AgentStatus;
	children: string[];
}

export interface AgentNetworkSnapshot {
	agents: AgentNetworkEntry[];
	rootId: string;
}

// === Agent Record (Hub-internal) ===
export interface AgentRecord {
	id: string;
	name: string;
	parentId: string | undefined;
	children: string[];
	port: number;
	status: AgentStatus;
	worker: import("node:worker_threads").Worker;
	cwd: string;
	model: string | undefined;
}

// === Hub Configuration ===
export interface HubConfig {
	port?: number;
	cwd: string;
	model?: string;
	agentPortStart?: number;
	workspaceRoot: string;
	workspaceContext: WorkspaceContext;
}

// === Tool Call Results ===
export interface SendMessageResult {
	ok: boolean;
	error?: string;
}

export interface CreateAgentResult {
	agentId: string;
	name: string;
}

export interface DestroyAgentResult {
	ok: boolean;
	error?: string;
}

// === Source Status ===
export type SourceStatus = "running" | "stopped" | "error";

// === Source Configuration ===
export interface SourceConfig {
	name: string;
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

// === Source Info (API responses) ===
export interface SourceInfo {
	name: string;
	command: string;
	args: string[];
	status: SourceStatus;
	subscriberCount: number;
}

// === Source Tool Call Results ===
export interface CreateSourceResult {
	ok: boolean;
	error?: string;
}

export interface DestroySourceResult {
	ok: boolean;
	error?: string;
}

export interface SubscribeSourceResult {
	ok: boolean;
	error?: string;
}

export interface UnsubscribeSourceResult {
	ok: boolean;
	error?: string;
}

export interface ListSourcesResult {
	sources: SourceInfo[];
}
