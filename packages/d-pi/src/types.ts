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
	version: 1 | 2;
}

export interface WorkspaceContext {
	workspaceRoot: string;
	appendSystemPrompt?: string;
	additionalAgentsFiles?: Array<{ path: string; content: string }>;
	additionalSkillPaths: string[];
	additionalExtensionPaths: string[];
}

// === Worker Configuration (passed via workerData) ===
//
// The `agentName` is the agent's identity; there is no separate id.
// `parentName` (when set) must match an existing agent's name — same
// uniqueness rule as `name` itself, enforced by the hub at restore
// time. The worker uses `agentName` to label every IPC message and
// every persisted `agent.json`.
export interface AgentWorkerConfig {
	agentName: string;
	parentName?: string;
	cwd: string;
	model?: string;
	workspaceContext?: WorkspaceContext;
	sessionId?: string;
	sessionDir?: string;
	includeTools?: string[];
	excludeTools?: string[];
}

// === Worker → Hub IPC Messages ===
//
// All agent-identity fields are names (not UUIDs). The hub dispatches
// `tool_call` back to the in-memory worker via the `agentName` field,
// which must match the registry key.
export type WorkerToHubMessage =
	| { type: "ready"; agentName: string }
	| { type: "error"; agentName: string; error: string }
	| { type: "tool_call"; agentName: string; tool: string; params: unknown; callId: string }
	| { type: "tool_call_timeout"; agentName: string; callId: string }
	| { type: "status_update"; agentName: string; status: AgentStatus }
	| { type: "http_response"; agentName: string; requestId: string; status: number; body: unknown }
	| { type: "sse_event"; agentName: string; subscriberId: string; event: string; data: unknown };

// === Hub → Worker IPC Messages ===
export type HubToWorkerMessage =
	| { type: "tool_result"; callId: string; result: unknown }
	| {
			type: "message";
			fromAgentName: string;
			content: string;
			sourceName?: string;
			mode?: "next" | "steer";
	  }
	| { type: "destroy" }
	| { type: "http_request"; requestId: string; action: string; data: unknown }
	| { type: "http_query"; requestId: string; query: string }
	| { type: "sse_subscribe"; subscriberId: string }
	| { type: "sse_unsubscribe"; subscriberId: string };

// === Team Snapshot ===
export interface TeamAgentEntry {
	name: string;
	parentName: string | undefined;
	status: AgentStatus;
	model: string | undefined;
	children: string[];
}

export interface TeamExecutorEntry {
	connectId: string;
	cwd: string;
	attached: boolean;
	boundAgentName: string | undefined;
}

export interface TeamSnapshot {
	agents: TeamAgentEntry[];
	executors: TeamExecutorEntry[];
	rootName: string;
}

// === Agent Record (Hub-internal) ===
//
// `name` is the unique key — see the "name is identity" rationale
// in the changelog. We deliberately don't carry a separate UUID; every
// cross-reference (parent, children, subscribers, meta) uses the name
// directly, which means persisted `agent.json`s and in-memory state
// can be joined back together by name without an indirection table.
export interface AgentRecord {
	name: string;
	parentName: string | undefined;
	children: string[];
	/** @deprecated Agents no longer bind HTTP ports in stdio/IPC mode. */
	port?: number;
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
	/** @deprecated Agents no longer bind HTTP ports in stdio/IPC mode. */
	agentPortStart?: number;
	workspaceRoot: string;
	workspaceContext: WorkspaceContext;
	workspaceConfig: WorkspaceConfig;
	/**
	 * Max time (ms) the hub will wait for an executor to return a
	 * result for a dispatched tool call, whether triggered from
	 * the public `/agents/{name}/remote-call` HTTP endpoint or
	 * from the in-process `remote` IPC tool used by `remote_*`
	 * agent tools. Default: 60_000.
	 */
	remoteCallTimeoutMs?: number;
}

// === Tool Call Results ===
export interface SendMessageResult {
	ok: boolean;
	error?: string;
}

export interface CreateAgentResult {
	agentName: string;
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
	subscribers?: string[];
}

// === Source Info (API responses) ===
export interface SourceInfo {
	name: string;
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	status: SourceStatus;
	subscribers: string[];
}

// === Source Tool Call Results ===
export interface SetSourceResult {
	ok: boolean;
	error?: string;
}

export interface GetSourceResult {
	source?: SourceInfo;
	sources?: SourceInfo[];
	error?: string;
}

export interface DeleteSourceResult {
	ok: boolean;
	error?: string;
}

export type {
	AgentContextFileDefinition,
	AgentDefinition,
	AgentModelDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
} from "./agent-definition.ts";
