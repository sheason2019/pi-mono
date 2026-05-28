import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "./agent-session.ts";

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
}
