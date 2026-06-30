import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api } from "@earendil-works/pi-ai";
import type { DPiTranscriptItem } from "../../runtime/transcript/projector.ts";

export interface DPiInteractiveProxyPromptOptions {
	images?: Array<{ url: string; mediaType?: string }>;
	streamingBehavior?: "steer" | "followUp";
}

export interface DPiInteractiveBannerKeyHint {
	key: string;
	description: string;
}

export interface DPiInteractiveLoadedResourceSection {
	name: string;
	compactList: string;
	expandedList: string;
}

export interface DPiInteractiveResourceDiagnosticEntry {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: {
		resourceType: "extension" | "skill" | "prompt" | "theme";
		name: string;
		winnerPath: string;
		loserPath: string;
		winnerSource?: string;
		loserSource?: string;
	};
}

export interface DPiInteractiveBannerData {
	appName: string;
	version: string;
	expandedHints: DPiInteractiveBannerKeyHint[];
	compactHints: DPiInteractiveBannerKeyHint[];
	compactOnboarding: string;
	onboarding: string;
	loadedResources: DPiInteractiveLoadedResourceSection[];
	diagnostics: Array<{
		label: string;
		entries: DPiInteractiveResourceDiagnosticEntry[];
	}>;
	changelogMarkdown: string | undefined;
}

export interface DPiInteractiveTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	usingSubscription: boolean;
	latestCacheHitRate?: number;
}

export interface DPiInteractiveContextUsageInfo {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface DPiInteractiveTurnStats {
	tps: number;
	output: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	duration: number;
}

export interface DPiInteractiveModelInfo {
	id: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
}

export interface DPiInteractiveModelItemData {
	id: string;
	name: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
}

export interface DPiInteractiveRemoteSettings {
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	httpIdleTimeoutMs: number;
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: Record<string, unknown>;
}

export interface DPiInteractiveSessionItemData {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface DPiInteractiveSlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	source: "builtin" | "agent" | "prompt" | "skill";
	sourceInfo?: unknown;
}

export interface DPiInteractiveTodoItem {
	id: string;
	title: string;
	description?: string;
	status: "pending" | "in_progress" | "completed";
}

export interface DPiInteractiveSessionStateSnapshot {
	model: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMessages: readonly string[];
	sessionFile: string | undefined;
	sessionName: string | undefined;
	messages: readonly AgentMessage[];
	transcriptItems?: readonly DPiTranscriptItem[];
	banner: DPiInteractiveBannerData | undefined;
	tokenUsage: DPiInteractiveTokenUsage;
	contextUsage: DPiInteractiveContextUsageInfo;
	modelInfo: DPiInteractiveModelInfo;
	autoCompactEnabled: boolean;
	cwd: string;
	availableProviderCount: number;
	remoteSettings: DPiInteractiveRemoteSettings;
	plan: DPiInteractiveTodoItem[];
}

export type DPiInteractiveAgentSessionEvent =
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName?: string; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName?: string; result: unknown; isError: boolean }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "compaction_start" }
	| { type: "compaction_end" }
	| { type: "queue_update"; steering: string[] }
	| { type: "state_update"; snapshot?: Partial<DPiInteractiveSessionStateSnapshot> }
	| ({ type: "turn_stats" } & DPiInteractiveTurnStats)
	| { type: "session_replaced"; reason: "new" | "resume" }
	| { type: "plan_update"; plan: DPiInteractiveTodoItem[] };

export interface DPiInteractiveAgentSessionProxy {
	subscribe(listener: (event: DPiInteractiveAgentSessionEvent) => void): () => void;
	prompt(text: string, options?: DPiInteractiveProxyPromptOptions): Promise<void>;
	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void;
	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void;
	abort(): void;
	clearQueue(): { steering: string[] };

	readonly model: string;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly steeringMessages: readonly string[];
	readonly sessionFile: string | undefined;
	readonly sessionName: string | undefined;
	readonly messages: readonly AgentMessage[];

	compact(customInstructions?: string): Promise<void>;

	newSession(): Promise<void>;
	switchSession(sessionFile: string): Promise<void>;
	renameSession(name: string): void;
	reload(): Promise<void>;

	updateSettings(updates: Record<string, unknown>): void;

	getSessions(): Promise<DPiInteractiveSessionItemData[]>;
	fetchCommands(): Promise<DPiInteractiveSlashCommand[]>;
	fetchModels(): Promise<DPiInteractiveModelItemData[]>;
	getCommands(): DPiInteractiveSlashCommand[];
	getModels(): DPiInteractiveModelItemData[];
	getSnapshot(): DPiInteractiveSessionStateSnapshot;
}
