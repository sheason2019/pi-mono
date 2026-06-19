import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import type { DPiContextFile } from "../context/resource-loader.ts";
import type { TeamSnapshot } from "../types.ts";

export type DPiJsonValue = null | boolean | number | string | DPiJsonValue[] | { [key: string]: DPiJsonValue };

export type DPiPromptMode = "next" | "steer" | "followUp";

export interface DPiAuthMetadata {
	name?: string;
	description?: string;
	userId?: string;
	openId?: string;
	roles?: string[];
}

export interface DPiConnectMetadata {
	connectId?: string;
	cwd?: string;
	auth?: DPiAuthMetadata;
}

export interface DPiPromptImage {
	mediaType: string;
	data?: string;
	url?: string;
}

export interface DPiPromptOptions {
	images?: DPiPromptImage[];
	mode?: DPiPromptMode;
	auth?: DPiAuthMetadata;
	connect?: DPiConnectMetadata;
}

export type DPiCustomMessageSource = "connect" | "agent" | "source" | "runtime";

export interface DPiCustomMessageDetails {
	sourceType: DPiCustomMessageSource;
	agentName?: string;
	sourceName?: string;
	connectId?: string;
	auth?: DPiAuthMetadata;
	metadata?: { [key: string]: DPiJsonValue };
}

export interface DPiCustomMessage {
	role: "custom";
	customType: "d-pi-message" | (string & {});
	content: DPiJsonValue;
	display?: boolean;
	details: DPiCustomMessageDetails;
	timestamp?: number;
}

export type DPiAgentMessage = AgentMessage | DPiCustomMessage;

export interface DPiStreamingState {
	active: boolean;
	message?: DPiAgentMessage;
	text?: string;
}

export interface DPiCompactionState {
	status: "idle" | "queued" | "running" | "failed";
	queued: boolean;
	startedAt?: number;
	finishedAt?: number;
	error?: string;
}

export interface DPiBashCommandState {
	id: string;
	command: string;
	status: "running" | "succeeded" | "failed" | "cancelled";
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	output?: string;
}

export interface DPiBashState {
	active: boolean;
	cwd: string;
	commands: DPiBashCommandState[];
	currentCommandId?: string;
}

export interface DPiPromptQueueItem {
	id: string;
	text: string;
	mode: DPiPromptMode;
	source: DPiCustomMessageSource;
	createdAt: number;
	options?: DPiPromptOptions;
}

export type DPiToolStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface DPiToolQueueItem {
	id: string;
	name: string;
	status: DPiToolStatus;
	createdAt: number;
	args?: DPiJsonValue;
	result?: DPiJsonValue;
	error?: string;
}

export interface DPiRuntimeQueues {
	prompts: DPiPromptQueueItem[];
	tools: DPiToolQueueItem[];
}

export interface DPiModelInfo {
	id: string;
	provider?: Provider;
	displayName?: string;
	contextWindow?: number;
}

export interface DPiThinkingState {
	level?: ThinkingLevel;
	budgetTokens?: number;
}

export interface DPiContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface DPiTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens?: number;
	latestCacheHitRate?: number;
	usingSubscription?: boolean;
}

export interface DPiRuntimeSessionInfo {
	id: string;
	turnId?: string;
	path?: string;
	parentSessionId?: string;
	replacedAt?: number;
}

export interface DPiRuntimeCommand {
	name: string;
	description?: string;
	enabled?: boolean;
	metadata?: { [key: string]: DPiJsonValue };
}

export interface DPiRuntimeSettings {
	theme?: string;
	approvalMode?: string;
	[key: string]: DPiJsonValue | undefined;
}

export interface DPiRuntimeContextInfo {
	systemPromptParts: string[];
	contextFiles: DPiContextFile[];
	skills: string[];
	extensions: string[];
}

export interface DPiRuntimeSnapshot {
	agentName: string;
	connectId?: string;
	cwd: string;
	context: DPiRuntimeContextInfo;
	messages: DPiAgentMessage[];
	streaming: DPiStreamingState;
	compaction: DPiCompactionState;
	bash: DPiBashState;
	queues: DPiRuntimeQueues;
	model: DPiModelInfo;
	thinking: DPiThinkingState;
	contextUsage: DPiContextUsage;
	tokenUsage: DPiTokenUsage;
	session: DPiRuntimeSessionInfo;
	commands: DPiRuntimeCommand[];
	settings: DPiRuntimeSettings;
	team?: TeamSnapshot;
}

export type DPiRuntimeStatePatch = Partial<
	Pick<
		DPiRuntimeSnapshot,
		| "streaming"
		| "compaction"
		| "bash"
		| "queues"
		| "context"
		| "model"
		| "thinking"
		| "contextUsage"
		| "tokenUsage"
		| "session"
		| "commands"
		| "settings"
		| "team"
	>
>;

export type DPiRuntimeErrorCode =
	| "busy"
	| "auth"
	| "invalid_session"
	| "missing_model"
	| "network"
	| "executor_unavailable"
	| "unknown";

export interface DPiRuntimeError {
	name: "DPiRuntimeError";
	code: DPiRuntimeErrorCode;
	message: string;
	retryable: boolean;
	details?: DPiJsonValue;
}
