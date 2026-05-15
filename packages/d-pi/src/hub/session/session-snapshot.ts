import type { ContextUsage, SessionContext, SessionEntry, SessionHeader } from "@sheason/pi-coding-agent";
import type { MessageSource } from "../agent/types.js";
import type { HubAvailableModel } from "./session-options.js";

export interface HubQueuedInputMessage {
	text: string;
	messageSource: MessageSource;
}

export type HubRunEndReason = "completed" | "interrupted" | "error";

export interface HubRunTiming {
	startedAt: string;
	endedAt: string;
	durationMs: number;
	endReason: HubRunEndReason;
}

export const HUB_RUN_TIMING_CUSTOM_TYPE = "run_timing";
export const HUB_AGENT_SUMMARY_CUSTOM_TYPE = "agent_summary";

export interface HubSessionSnapshot {
	header: SessionHeader;
	sessionFile: string;
	entries: SessionEntry[];
	context: SessionContext;
	availableModels: HubAvailableModel[];
	availableThinkingLevels: string[];
	isRunning: boolean;
	pendingToolCallIds: string[];
	queuedMessages?: HubQueuedInputMessage[];
	contextUsage?: ContextUsage;
	lastError?: string;
	diagnostics: string[];
	summary?: string;
	runStartedAt?: string;
	lastRunStartedAt?: string;
	lastRunEndedAt?: string;
	lastRunDurationMs?: number;
	lastRunEndReason?: HubRunEndReason;
}
