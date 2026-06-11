import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { SourceInfo } from "./source-info.ts";

export interface ProxyPromptOptions {
	images?: Array<{ url: string; mediaType?: string }>;
	streamingBehavior?: "steer" | "followUp";
}

/** A single keybinding hint entry for the startup banner. */
export interface BannerKeyHint {
	/** Display text for the key (e.g. "Ctrl+C", "/", "!!") */
	key: string;
	/** Description of what the key does (e.g. "to interrupt", "for commands") */
	description: string;
}

/** A loaded resource section (Context, Skills, Prompts, Extensions, Themes). */
export interface LoadedResourceSection {
	/** Section name (e.g. "Context", "Skills", "Prompts", "Extensions", "Themes") */
	name: string;
	/** Compact display (single line, comma-separated) */
	compactList: string;
	/** Expanded display (one item per line, with paths) */
	expandedList: string;
}

/** A diagnostic entry for resource conflicts/errors. */
export interface ResourceDiagnosticEntry {
	/** Diagnostic type */
	type: "warning" | "error" | "collision";
	/** Human-readable message */
	message: string;
	/** File path if applicable */
	path?: string;
	/** Collision details if type is "collision" */
	collision?: {
		resourceType: "extension" | "skill" | "prompt" | "theme";
		name: string;
		winnerPath: string;
		loserPath: string;
		winnerSource?: string;
		loserSource?: string;
	};
}

/** Structured banner data, theme-independent so connect clients can render with their own theme. */
export interface BannerData {
	/** App name */
	appName: string;
	/** Version string (e.g. "0.76.0") */
	version: string;
	/** Expanded keybinding hints (shown when banner is expanded) */
	expandedHints: BannerKeyHint[];
	/** Compact keybinding hints (shown when banner is collapsed) */
	compactHints: BannerKeyHint[];
	/** Compact onboarding text */
	compactOnboarding: string;
	/** Full onboarding text */
	onboarding: string;
	/** Loaded resource sections (Context, Skills, Prompts, etc.) */
	loadedResources: LoadedResourceSection[];
	/** Diagnostics (Skill conflicts, Prompt conflicts, Extension issues, etc.) */
	diagnostics: Array<{
		/** Section label (e.g. "Skill conflicts", "Prompt conflicts", "Extension issues") */
		label: string;
		/** Diagnostic entries */
		entries: ResourceDiagnosticEntry[];
	}>;
	/** Changelog markdown for "What's New" section, or undefined if no new entries */
	changelogMarkdown: string | undefined;
}

/** Cumulative token usage across all assistant messages in the session. */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	usingSubscription: boolean;
}

/** Context window usage info for the current branch. */
export interface ContextUsageInfo {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Model details needed by the footer and UI. */
export interface ModelInfo {
	id: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
}

/**
 * Model item for remote model selector. Field-compatible with `Model<any>`
 * (the upstream `ScopedModelsSelectorComponent`'s expected input type) so
 * connect-mode callers can cast `ModelItemData[]` to `Model<any>[]` without
 * fabricating missing fields. Fields mirror the relevant subset of
 * `packages/ai/src/types.ts#Model`.
 */
export interface ModelItemData {
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

/** Settings that can be read and modified remotely via serve mode. */
export interface RemoteSettings {
	autoCompact: boolean;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: readonly ThinkingLevel[];
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	enableSkillCommands: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	// Extended server-side settings
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	transport: string;
	httpIdleTimeoutMs: number;
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	treeFilterMode: string;
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: Record<string, unknown>;
}

/** Lightweight tree node for wire transport (no full message content). */
export interface TreeNodeData {
	id: string;
	type: string;
	parentId: string | null;
	timestamp: string;
	label?: string;
	/** Preview text for message entries */
	preview?: string;
	children: TreeNodeData[];
}

/** User message item for fork selector. */
export interface UserMessageItem {
	id: string;
	text: string;
}

/** Session info for session selector. */
export interface SessionItemData {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

/** Slash command exposed via serve mode for connect mode autocomplete. */
export interface ServeSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Argument hint (e.g. "<provider/model-id>") */
	argumentHint?: string;
	/** What kind of command this is */
	source: "builtin" | "extension" | "prompt" | "skill";
	/** Source metadata (absent for builtin commands) */
	sourceInfo?: SourceInfo;
}

export interface SessionStateSnapshot {
	model: string;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning: boolean;
	steeringMessages: readonly string[];
	followUpMessages: readonly string[];
	sessionFile: string | undefined;
	sessionName: string | undefined;
	messages: readonly AgentMessage[];
	banner: BannerData | undefined;
	tokenUsage: TokenUsage;
	contextUsage: ContextUsageInfo;
	modelInfo: ModelInfo;
	autoCompactEnabled: boolean;
	cwd: string;
	availableProviderCount: number;
	remoteSettings: RemoteSettings;
	/** Currently scoped model IDs for Ctrl+P cycling (null = all enabled) */
	scopedModelIds: string[] | null;
	/** Persisted enabled model patterns from settings */
	enabledModelPatterns: string[] | undefined;
	/** Extension paths loaded on the server — client can load the same extensions for UI */
	extensionPaths: string[];
}

export interface AgentSessionProxy {
	// Event subscription
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;

	// Commands
	prompt(text: string, options?: ProxyPromptOptions): Promise<void>;
	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void;
	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void;
	abort(): void;
	abortBash(): void;

	// State queries
	readonly model: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isBashRunning: boolean;
	readonly steeringMessages: readonly string[];
	readonly followUpMessages: readonly string[];
	readonly sessionFile: string | undefined;
	readonly sessionName: string | undefined;
	readonly messages: readonly AgentMessage[];

	// Session operations
	compact(customInstructions?: string): Promise<void>;
	setModel(modelId: string): void;
	cycleModel(direction: 1 | -1): void;
	setThinkingLevel(level: ThinkingLevel): void;
	cycleThinkingLevel(direction: 1 | -1): void;
	setAutoCompactEnabled(enabled: boolean): void;
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;

	// Runtime operations
	newSession(): Promise<void>;
	switchSession(sessionFile: string): Promise<void>;
	fork(entryId?: string): Promise<void>;
	renameSession(name: string): void;
	setLabel(entryId: string, label: string | undefined): void;
	reload(): Promise<void>;

	// Scoped model management
	setScopedModels(enabledIds: string[] | null): void;
	setEnabledModels(patterns: string[] | undefined): void;

	/** Generic settings update — applies a batch of key/value pairs to the server's SettingsManager */
	updateSettings(updates: Record<string, unknown>): void;

	// Data queries (for connect mode selectors)
	getTree(): TreeNodeData[];
	getUserMessagesForForking(): UserMessageItem[];
	getSessions(): Promise<SessionItemData[]>;

	/** Async variants for remote proxies — local impl wraps sync methods */
	fetchTree(): Promise<TreeNodeData[]>;
	fetchUserMessages(): Promise<UserMessageItem[]>;
	fetchCommands(): Promise<ServeSlashCommand[]>;
	fetchModels(): Promise<ModelItemData[]>;

	// Command discovery
	getCommands(): ServeSlashCommand[];

	// Model discovery
	getModels(): ModelItemData[];

	// Lifecycle
	dispose(): void;

	// Snapshot
	getSnapshot(): SessionStateSnapshot;
}
