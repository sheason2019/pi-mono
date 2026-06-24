import type { Worker } from "node:worker_threads";

// === Agent Status ===
export type AgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

export interface WorkspaceReloadMetadata {
	reason?: string;
	caller: string;
	time: string;
}

// === Agent Config (normalized from agent.ts in each agent's cwd) ===
//
// The normalized contents of agent.ts are injected into the agent's
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
}

// === Workspace Configuration ===
export interface WorkspaceConfig {}

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
// every persisted `agent.ts`.
export interface AgentWorkerConfig {
	agentName: string;
	parentName?: string;
	cwd: string;
	workspaceContext?: WorkspaceContext;
	sessionDir?: string;
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
	| { type: "reload_workspace"; agentName: string; callId: string; reason?: string }
	| {
			type: "reload_agent_result";
			agentName: string;
			callId: string;
			ok: boolean;
			metadata: WorkspaceReloadMetadata;
			error?: string;
	  }
	| { type: "http_response"; agentName: string; requestId: string; status: number; body: unknown }
	| { type: "sse_event"; agentName: string; subscriberId: string; event: string; data: unknown };

// === Hub → Worker IPC Messages ===
export type HubToWorkerMessage =
	| { type: "tool_result"; callId: string; result: unknown }
	| { type: "reload_agent"; callId: string; metadata: WorkspaceReloadMetadata }
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
// directly, which means persisted `agent.ts` configs and in-memory state
// can be joined back together by name without an indirection table.
export interface AgentRecord {
	name: string;
	parentName: string | undefined;
	children: string[];
	/** @deprecated Agents no longer bind HTTP ports in stdio/IPC mode. */
	port?: number;
	status: AgentStatus;
	worker: Worker;
	cwd: string;
}

// === Hub Configuration ===
export interface HubConfig {
	port?: number;
	cwd: string;
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

export type {
	AgentContextFileDefinition,
	AgentDefinition,
	AgentLocalModelDefinition,
	AgentModelDefinition,
	AgentModelReferenceDefinition,
	AgentProviderDefinition,
	AgentRoleDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
	AgentToolDefinitionInput,
} from "./agent-definition.ts";
