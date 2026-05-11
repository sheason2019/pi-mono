import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HubAuthIdentity } from "../auth/token-store.js";
import type { McpRuntimeStatus } from "../mcp/types.js";
import type { PeerConfigPayload, PeerHelloPayload } from "../peers/peer-types.js";
import type { SourceRuntimeStatus } from "../sources/source-types.js";

export const HUB_PROTOCOL_VERSION = 4;

export interface HubWelcomePayload {
	sessionId: string;
	peerId: string;
	/** Hub agent this peer is bound to (immutable after `peer:hello` ack), e.g. `root` or a child id. */
	agentId: string;
	clientKind?: "peer" | "host";
	hubVersion: string;
	protocolVersion: number;
	toolNames: string[];
	identity: HubAuthIdentity;
	scopeRootAgentId: string;
}

export type SessionCrdtSyncFormat = "snapshot" | "incremental" | "sync";

export interface SessionCrdtSyncPayload {
	message: Uint8Array;
	format?: SessionCrdtSyncFormat;
}

export type PeerHelloAck = { ok: true } | { ok: false; error: string };
export type PeerConfigAck = { ok: true } | { ok: false; error: string };
export type ActionAck = { ok: true } | { ok: false; error: string };

export type { LiveRenderEvent, LiveRenderEventType } from "./live-events.js";

export type PublicAgentActivationStatus = "running" | "loading" | "not_hydrated" | "error";

export interface PublicOrgAgent {
	id: string;
	parentId?: string;
	kind?: "root" | "child";
	lifecycle?: "persistent" | "temporary";
	name?: string;
	activationStatus: PublicAgentActivationStatus;
	isRunning: boolean;
	peerCount: number;
	hasError: boolean;
}

export interface PublicOrgSnapshot {
	app: "d-pi hub";
	version: string;
	protocolVersion: number;
	generatedAt: string;
	agents: PublicOrgAgent[];
}

export interface SessionQueueWritePayload {
	text: string;
	sentAt?: string;
}

export interface SessionQueueFlushPayload {}

export interface SourceMessagePayload {
	sourceName: string;
	text: string;
	agentId?: string;
}

export interface SessionAbortPayload {}

export interface SessionSetModelPayload {
	modelResourceId: string;
}

export interface SessionSetThinkingLevelPayload {
	level: string;
}

export interface SessionInvokeCommandPayload {
	commandName: string;
	args?: string;
}

export interface SessionGetSourcesPayload {}

export type SessionGetSourcesAck = { ok: true; sources: SourceRuntimeStatus[] } | { ok: false; error: string };

export interface SessionPauseSourcePayload {
	resourceId: string;
}

export interface SessionRestartSourcePayload {
	resourceId: string;
}

export interface SessionRemoveSourcePayload {
	resourceId: string;
}

export type SessionMutateSourceAck = { ok: true; sources: SourceRuntimeStatus[] } | { ok: false; error: string };

export interface SessionGetMcpServersPayload {}

/**
 * `configError` is present only when the hub has a config parse/read error
 * (mirrors `McpHost.getConfigError()` when set).
 */
export type SessionGetMcpServersAck =
	| { ok: true; servers: McpRuntimeStatus[]; configError?: string }
	| { ok: false; error: string };

export interface HubSkillInfo {
	name: string;
	description: string;
	filePath: string;
	sourceInfo?: unknown;
	disableModelInvocation: boolean;
}

export interface HubSkillDiagnostic {
	type: string;
	message: string;
	path?: string;
}

export interface SessionGetSkillsPayload {}

export type SessionGetSkillsAck =
	| { ok: true; skills: HubSkillInfo[]; diagnostics: HubSkillDiagnostic[] }
	| { ok: false; error: string };

export interface SessionPauseMcpServerPayload {
	resourceId: string;
}

export interface SessionRestartMcpServerPayload {
	resourceId: string;
}

export interface SessionRemoveMcpServerPayload {
	resourceId: string;
}

export type SessionMutateMcpServerAck = { ok: true; servers: McpRuntimeStatus[] } | { ok: false; error: string };

export interface ToolCallRequestPayload {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	timeoutMs: number;
}

export interface ToolCallAckPayload {
	toolCallId: string;
}

export interface ToolCallUpdatePayload {
	toolCallId: string;
	partialResult: AgentToolResult<unknown>;
}

export interface ToolCallResultPayload {
	toolCallId: string;
	result: AgentToolResult<unknown>;
}

export interface ToolCallErrorPayload {
	toolCallId: string;
	message: string;
}

export interface ClientToServerEvents {
	"peer:hello": (payload: PeerHelloPayload, ack: (response: PeerHelloAck) => void) => void;
	"peer:config": (payload: PeerConfigPayload, ack: (response: PeerConfigAck) => void) => void;
	"session:queue_write": (payload: SessionQueueWritePayload, ack: (response: ActionAck) => void) => void;
	"session:queue_flush": (payload: SessionQueueFlushPayload, ack: (response: ActionAck) => void) => void;
	"source:message": (payload: SourceMessagePayload, ack: (response: ActionAck) => void) => void;
	"session:abort": (payload: SessionAbortPayload, ack: (response: ActionAck) => void) => void;
	"session:set_model": (payload: SessionSetModelPayload, ack: (response: ActionAck) => void) => void;
	"session:set_thinking_level": (payload: SessionSetThinkingLevelPayload, ack: (response: ActionAck) => void) => void;
	"session:invoke_command": (payload: SessionInvokeCommandPayload, ack: (response: ActionAck) => void) => void;
	"session:get_sources": (payload: SessionGetSourcesPayload, ack: (response: SessionGetSourcesAck) => void) => void;
	"session:pause_source": (
		payload: SessionPauseSourcePayload,
		ack: (response: SessionMutateSourceAck) => void,
	) => void;
	"session:restart_source": (
		payload: SessionRestartSourcePayload,
		ack: (response: SessionMutateSourceAck) => void,
	) => void;
	"session:remove_source": (
		payload: SessionRemoveSourcePayload,
		ack: (response: SessionMutateSourceAck) => void,
	) => void;
	"session:get_mcp_servers": (
		payload: SessionGetMcpServersPayload,
		ack: (response: SessionGetMcpServersAck) => void,
	) => void;
	"session:get_skills": (payload: SessionGetSkillsPayload, ack: (response: SessionGetSkillsAck) => void) => void;
	"session:pause_mcp_server": (
		payload: SessionPauseMcpServerPayload,
		ack: (response: SessionMutateMcpServerAck) => void,
	) => void;
	"session:restart_mcp_server": (
		payload: SessionRestartMcpServerPayload,
		ack: (response: SessionMutateMcpServerAck) => void,
	) => void;
	"session:remove_mcp_server": (
		payload: SessionRemoveMcpServerPayload,
		ack: (response: SessionMutateMcpServerAck) => void,
	) => void;
	"session:crdt_sync": (payload: SessionCrdtSyncPayload) => void;
	"session:crdt_resync_request": () => void;
	"tool:call_ack": (payload: ToolCallAckPayload) => void;
	"tool:call_update": (payload: ToolCallUpdatePayload) => void;
	"tool:call_result": (payload: ToolCallResultPayload) => void;
	"tool:call_error": (payload: ToolCallErrorPayload) => void;
}

export interface ServerToClientEvents {
	"hub:welcome": (payload: HubWelcomePayload) => void;
	"session:crdt_sync": (payload: SessionCrdtSyncPayload) => void;
	"tool:call_request": (payload: ToolCallRequestPayload) => void;
}
