import {
	type AgentSession,
	buildSessionContext,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { assertWorkspaceInitialized, getWorkspacePaths } from "../workspace.js";
import type { HubSessionEvent } from "./session-events.js";
import { DEFAULT_AVAILABLE_THINKING_LEVELS, type HubAvailableModel } from "./session-options.js";
import {
	HUB_RUN_TIMING_CUSTOM_TYPE,
	type HubQueuedInputMessage,
	type HubRunEndReason,
	type HubRunTiming,
	type HubSessionSnapshot,
} from "./session-snapshot.js";

export const DISABLED_SESSION_COMMAND_NAMES = ["new", "resume", "tree", "fork", "clone"] as const;

const DISABLED_SESSION_COMMANDS = new Set<string>(DISABLED_SESSION_COMMAND_NAMES);

export interface HubSessionServiceOptions {
	now?: () => number;
}

export class UnsupportedSessionOperationError extends Error {
	constructor(commandName: string) {
		super(`Session operation "${commandName}" is disabled in pi-hub single-session mode.`);
	}
}

export class HubSessionService {
	private readonly sessionManager: SessionManager;
	private readonly sessionFile: string;
	private readonly now: () => number;
	private seq = 0;
	private isRunning = false;
	private runStartedAt: string | undefined;
	private lastRunStartedAt: string | undefined;
	private lastRunEndedAt: string | undefined;
	private lastRunDurationMs: number | undefined;
	private lastRunEndReason: HubRunEndReason | undefined;
	private readonly pendingToolCallIds = new Set<string>();
	private queuedMessages: HubQueuedInputMessage[] = [];
	private lastError: string | undefined;
	private diagnostics: string[] = [];
	private availableModels: HubAvailableModel[] = [];
	private availableThinkingLevels: string[] = [...DEFAULT_AVAILABLE_THINKING_LEVELS];
	private boundAgentSession: AgentSession | undefined;
	private readonly listeners = new Set<(event: HubSessionEvent) => void>();

	private constructor(sessionManager: SessionManager, sessionFile: string, options: HubSessionServiceOptions = {}) {
		this.sessionManager = sessionManager;
		this.sessionFile = sessionFile;
		this.now = options.now ?? (() => Date.now());
		this.hydrateLastRunTimingFromEntries();
	}

	static open(cwd: string = process.cwd(), options: HubSessionServiceOptions = {}): HubSessionService {
		const paths = assertWorkspaceInitialized(cwd);
		const sessionManager = SessionManager.open(paths.sessionFile, paths.workspaceDir, cwd);
		return new HubSessionService(sessionManager, paths.sessionFile, options);
	}

	static openAgent(cwd: string, sessionFile: string, options: HubSessionServiceOptions = {}): HubSessionService {
		const paths = assertWorkspaceInitialized(cwd);
		const sessionManager = SessionManager.open(sessionFile, paths.workspaceDir, cwd);
		return new HubSessionService(sessionManager, sessionFile, options);
	}

	static createIfMissing(cwd: string = process.cwd(), options: HubSessionServiceOptions = {}): HubSessionService {
		const paths = getWorkspacePaths(cwd);
		const sessionManager = SessionManager.open(paths.sessionFile, paths.workspaceDir, cwd);
		return new HubSessionService(sessionManager, paths.sessionFile, options);
	}

	getSessionManager(): SessionManager {
		return this.sessionManager;
	}

	getHeader(): SessionHeader {
		const header = this.sessionManager.getHeader();
		if (!header) {
			throw new Error("Hub session is missing a session header.");
		}
		return header;
	}

	getEntries(): SessionEntry[] {
		return this.sessionManager.getEntries();
	}

	getSnapshot(): HubSessionSnapshot {
		const visibleQueue = this.getVisibleInputQueue();
		return {
			header: this.getHeader(),
			sessionFile: this.sessionFile,
			entries: this.getEntries(),
			context: this.getContextSnapshot(),
			availableModels: [...this.availableModels],
			availableThinkingLevels: [...this.availableThinkingLevels],
			isRunning: this.isRunning,
			pendingToolCallIds: [...this.pendingToolCallIds],
			queuedMessages: visibleQueue.map((message) => ({ ...message })),
			contextUsage: this.boundAgentSession?.getContextUsage(),
			lastError: this.lastError,
			diagnostics: [...this.diagnostics],
			runStartedAt: this.runStartedAt,
			lastRunStartedAt: this.lastRunStartedAt,
			lastRunEndedAt: this.lastRunEndedAt,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunEndReason: this.lastRunEndReason,
		};
	}

	subscribe(listener: (event: HubSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	bindAgentSession(
		session: AgentSession,
		options?: {
			diagnostics?: string[];
		},
	): HubSessionEvent {
		this.boundAgentSession = session;
		this.diagnostics = [...(options?.diagnostics ?? [])];
		return this.syncBoundAgentSession();
	}

	unbindAgentSession(): HubSessionEvent {
		this.boundAgentSession = undefined;
		this.pendingToolCallIds.clear();
		this.isRunning = false;
		this.queuedMessages = [];
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	syncBoundAgentSession(): HubSessionEvent {
		if (this.boundAgentSession) {
			this.isRunning = this.boundAgentSession.isStreaming;
			this.pendingToolCallIds.clear();
			for (const toolCallId of this.boundAgentSession.state.pendingToolCalls) {
				this.pendingToolCallIds.add(toolCallId);
			}
			this.refreshVisibleInputQueue();
		}
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	assertOperationSupported(commandName: string): void {
		if (DISABLED_SESSION_COMMANDS.has(commandName)) {
			throw new UnsupportedSessionOperationError(commandName);
		}
	}

	setRunState(isRunning: boolean, reason: HubRunEndReason = "completed"): HubSessionEvent {
		if (isRunning && !this.runStartedAt) {
			const startedAt = new Date(this.now()).toISOString();
			this.runStartedAt = startedAt;
			this.lastRunStartedAt = startedAt;
		}
		let runTiming: HubRunTiming | undefined;
		if (!isRunning && this.isRunning && this.runStartedAt) {
			const endedAtMs = this.now();
			const startedAtMs = Date.parse(this.runStartedAt);
			const endedAt = new Date(endedAtMs).toISOString();
			const durationMs = Math.max(0, endedAtMs - startedAtMs);
			this.lastRunEndedAt = endedAt;
			this.lastRunDurationMs = durationMs;
			this.lastRunEndReason = reason;
			runTiming = {
				startedAt: this.runStartedAt,
				endedAt,
				durationMs,
				endReason: reason,
			};
			this.sessionManager.appendCustomEntry(HUB_RUN_TIMING_CUSTOM_TYPE, runTiming);
			this.runStartedAt = undefined;
		}
		this.isRunning = isRunning;
		return this.emit({
			type: "run_state_changed",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
			isRunning,
			runStartedAt: this.runStartedAt,
			lastRunStartedAt: this.lastRunStartedAt,
			lastRunEndedAt: this.lastRunEndedAt,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunEndReason: this.lastRunEndReason,
			lastError: this.lastError,
			runTiming,
		});
	}

	setInputQueue(messages: readonly HubQueuedInputMessage[]): HubSessionEvent {
		this.queuedMessages = messages.map((message) => ({ ...message }));
		this.refreshVisibleInputQueue();
		return this.emitQueueChangedEvent();
	}

	getInputQueue(): HubQueuedInputMessage[] {
		return this.getVisibleInputQueue();
	}

	addPendingToolCall(toolCallId: string): HubSessionEvent {
		this.pendingToolCallIds.add(toolCallId);
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	removePendingToolCall(toolCallId: string): HubSessionEvent {
		this.pendingToolCallIds.delete(toolCallId);
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	clearError(): HubSessionEvent {
		this.lastError = undefined;
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	recordError(message: string, options: { endRun?: boolean } = {}): HubSessionEvent {
		this.lastError = message;
		if (this.isRunning && options.endRun !== false) {
			this.setRunState(false, "error");
		}
		return this.emit({
			type: "error",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
			message,
		});
	}

	updateDiagnostics(diagnostics: string[]): HubSessionEvent {
		this.diagnostics = [...diagnostics];
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	updateSessionOptions(options: {
		availableModels: HubAvailableModel[];
		availableThinkingLevels?: string[];
	}): HubSessionEvent {
		this.availableModels = [...options.availableModels];
		this.availableThinkingLevels = [...(options.availableThinkingLevels ?? DEFAULT_AVAILABLE_THINKING_LEVELS)];
		return this.emit({
			type: "snapshot_updated",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
		});
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	private refreshVisibleInputQueue(): void {
		this.queuedMessages = this.getVisibleInputQueue();
	}

	private getVisibleInputQueue(): HubQueuedInputMessage[] {
		return [...this.queuedMessages];
	}

	private emitQueueChangedEvent(): HubSessionEvent {
		return this.emit({
			type: "queue_changed",
			seq: this.nextSeq(),
			timestamp: new Date().toISOString(),
			messages: this.getVisibleInputQueue(),
		});
	}

	private getContextSnapshot() {
		if (!this.boundAgentSession) {
			return buildSessionContext(this.sessionManager.getBranch());
		}

		return {
			messages: [...this.boundAgentSession.messages],
			thinkingLevel: this.boundAgentSession.thinkingLevel,
			model: this.boundAgentSession.model
				? {
						provider: this.boundAgentSession.model.provider,
						modelId: this.boundAgentSession.model.id,
					}
				: null,
		};
	}

	private emit(event: HubSessionEvent): HubSessionEvent {
		for (const listener of this.listeners) {
			listener(event);
		}
		return event;
	}

	private hydrateLastRunTimingFromEntries(): void {
		const entries = this.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry.customType !== HUB_RUN_TIMING_CUSTOM_TYPE) {
				continue;
			}
			const timing = parseHubRunTiming(entry.data);
			if (!timing) {
				continue;
			}
			this.lastRunStartedAt = timing.startedAt;
			this.lastRunEndedAt = timing.endedAt;
			this.lastRunDurationMs = timing.durationMs;
			this.lastRunEndReason = timing.endReason;
			return;
		}
	}
}

function isHubRunEndReason(value: unknown): value is HubRunEndReason {
	return value === "completed" || value === "interrupted" || value === "error";
}

function validIsoString(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseHubRunTiming(value: unknown): HubRunTiming | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Partial<HubRunTiming>;
	if (
		!validIsoString(candidate.startedAt) ||
		!validIsoString(candidate.endedAt) ||
		typeof candidate.durationMs !== "number" ||
		!Number.isFinite(candidate.durationMs) ||
		!isHubRunEndReason(candidate.endReason)
	) {
		return undefined;
	}
	return {
		startedAt: candidate.startedAt,
		endedAt: candidate.endedAt,
		durationMs: candidate.durationMs,
		endReason: candidate.endReason,
	};
}
