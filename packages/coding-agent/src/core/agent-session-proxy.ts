import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "./agent-session.ts";

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

export interface SessionStateSnapshot {
	model: string;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMessages: readonly string[];
	followUpMessages: readonly string[];
	sessionFile: string | undefined;
	sessionName: string | undefined;
	messages: readonly AgentMessage[];
	banner: BannerData | undefined;
}

export interface AgentSessionProxy {
	// Event subscription
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;

	// Commands
	prompt(text: string, options?: { images?: Array<{ url: string; mediaType?: string }> }): Promise<void>;
	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void;
	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void;
	abort(): void;

	// State queries
	readonly model: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
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

	// Runtime operations
	newSession(): Promise<void>;
	switchSession(sessionFile: string): Promise<void>;
	fork(entryIndex?: number): Promise<void>;

	// Lifecycle
	dispose(): void;

	// Snapshot
	getSnapshot(): SessionStateSnapshot;
}
