// === Agent Status ===
export type AgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

// === Agent Config (persisted as agent.json in each agent's cwd) ===
//
// The full contents of agent.json are injected into the agent's
// system prompt as the "## Agent identity" section (see
// `packages/d-pi/src/hub/agent-identity.ts` and the worker in
// `packages/d-pi/src/worker/agent-worker.ts`). Keep that in mind
// when adding fields here: every key becomes part of the agent's
// self-description, and cache invalidation is acceptable when the
// file changes (the agent's session is resumed against a new
// snapshot each time).
export interface AgentConfig {
	name: string;
	parentName: string | undefined;
	// Free-form prose about what this agent is, who it serves, and
	// when to delegate to it. Intended for the LLM to read.
	description?: string;
	roles?: string[];
	model?: string;
	sessionId?: string;
	includeTools?: string[];
	excludeTools?: string[];
}

// === Workspace Configuration ===
// Only `version` is currently defined. Reserved as a migration marker — future
// workspace-level fields should bump `version` and be parsed by
// validateWorkspace() with explicit version checks.
export interface WorkspaceConfig {
	version: 1;
}

export interface WorkspaceContext {
	workspaceRoot: string;
	appendSystemPrompt?: string;
	additionalAgentsFiles?: Array<{ path: string; content: string }>;
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
	includeTools?: string[];
	excludeTools?: string[];
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
	| {
			type: "message";
			fromAgentId: string;
			content: string;
			sourceName?: string;
			mode?: "next" | "steer";
	  }
	| { type: "destroy" };

// === Group Architecture Snapshot ===
export interface GroupArchitectureEntry {
	id: string;
	name: string;
	parentId: string | undefined;
	status: AgentStatus;
	model: string | undefined;
	children: string[];
}

export interface GroupArchitectureSnapshot {
	agents: GroupArchitectureEntry[];
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
	workspaceConfig: WorkspaceConfig;
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
export type SourceStatus = "running" | "stopped" | "error" | "failed";

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
