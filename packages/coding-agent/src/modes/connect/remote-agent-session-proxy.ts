import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type {
	AgentSessionProxy,
	ContextUsageInfo,
	ModelInfo,
	ModelItemData,
	ServeSlashCommand,
	SessionItemData,
	SessionStateSnapshot,
	TokenUsage,
	TreeNodeData,
	UserMessageItem,
} from "../../core/agent-session-proxy.ts";
import { SseClient } from "./sse-client.ts";

type Listener = (event: AgentSessionEvent) => void;
type DisconnectCallback = (reason: string) => void;

export class RemoteAgentSessionProxy implements AgentSessionProxy {
	private _state: SessionStateSnapshot;
	private readonly _subscribers: Set<Listener> = new Set();
	private readonly _sseClient: SseClient;
	private readonly _baseUrl: string;
	private readonly _onDisconnect: DisconnectCallback | undefined;

	constructor(baseUrl: string, initialState: SessionStateSnapshot, onDisconnect?: DisconnectCallback) {
		this._baseUrl = baseUrl;
		this._state = initialState;
		this._onDisconnect = onDisconnect;

		this._sseClient = new SseClient(
			`${baseUrl}/events`,
			(event) => this._handleEvent(event),
			(error) => {
				process.stderr.write(`[connect] SSE error: ${error.message}\n`);
				this._onDisconnect?.(`SSE error: ${error.message}`);
			},
			() => {
				process.stderr.write(`[connect] SSE connection closed\n`);
				this._onDisconnect?.(`SSE connection closed`);
			},
		);
	}

	async connect(): Promise<void> {
		await this._sseClient.connect();
	}

	private _handleEvent(event: AgentSessionEvent): void {
		this._updateState(event);
		for (const subscriber of this._subscribers) {
			subscriber(event);
		}
	}

	private _updateState(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
			case "message_end":
				// Messages managed via events, not the messages array
				break;
			case "agent_start":
				this._state = { ...this._state, isStreaming: true };
				break;
			case "agent_end":
				this._state = { ...this._state, isStreaming: false };
				break;
			case "compaction_start":
				this._state = { ...this._state, isCompacting: true };
				break;
			case "compaction_end":
				this._state = { ...this._state, isCompacting: false };
				break;
			case "queue_update":
				this._state = {
					...this._state,
					steeringMessages: event.steering,
					followUpMessages: event.followUp,
				};
				break;
			case "session_info_changed":
				this._state = { ...this._state, sessionName: event.name };
				break;
			case "thinking_level_changed":
				this._state = { ...this._state, thinkingLevel: event.level };
				break;
			case "state_update":
				// Server pushes a full snapshot update with token usage, context usage, etc.
				if (event.snapshot) {
					this._state = { ...this._state, ...event.snapshot };
				}
				break;
		}
	}

	private async _post(endpoint: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${this._baseUrl}/${endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await response.json();
		if (!response.ok) {
			throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
		}
		return data;
	}

	// Event subscription
	subscribe(listener: Listener): () => void {
		this._subscribers.add(listener);
		return () => {
			this._subscribers.delete(listener);
		};
	}

	// Commands
	async prompt(text: string, options?: { images?: Array<{ url: string; mediaType?: string }> }): Promise<void> {
		await this._post("prompt", { text, options });
	}

	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		this._post("steer", { text, images }).catch((e: Error) => {
			process.stderr.write(`[connect] steer failed: ${e.message}\n`);
		});
	}

	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		this._post("follow-up", { text, images }).catch((e: Error) => {
			process.stderr.write(`[connect] followUp failed: ${e.message}\n`);
		});
	}

	abort(): void {
		this._post("abort").catch((e: Error) => {
			process.stderr.write(`[connect] abort failed: ${e.message}\n`);
		});
	}

	abortBash(): void {
		this._post("abort-bash").catch((e: Error) => {
			process.stderr.write(`[connect] abortBash failed: ${e.message}\n`);
		});
	}

	// State queries
	get model(): string {
		return this._state.model;
	}
	get thinkingLevel(): ThinkingLevel {
		return this._state.thinkingLevel;
	}
	get isStreaming(): boolean {
		return this._state.isStreaming;
	}
	get isCompacting(): boolean {
		return this._state.isCompacting;
	}
	get isBashRunning(): boolean {
		return this._state.isBashRunning;
	}
	get steeringMessages(): readonly string[] {
		return this._state.steeringMessages;
	}
	get followUpMessages(): readonly string[] {
		return this._state.followUpMessages;
	}
	get sessionFile(): string | undefined {
		return this._state.sessionFile;
	}
	get sessionName(): string | undefined {
		return this._state.sessionName;
	}
	get messages(): readonly AgentMessage[] {
		return this._state.messages;
	}
	get tokenUsage(): TokenUsage {
		return this._state.tokenUsage;
	}
	get contextUsage(): ContextUsageInfo {
		return this._state.contextUsage;
	}
	get modelInfo(): ModelInfo {
		return this._state.modelInfo;
	}
	get autoCompactEnabled(): boolean {
		return this._state.autoCompactEnabled;
	}
	get cwd(): string {
		return this._state.cwd;
	}
	get availableProviderCount(): number {
		return this._state.availableProviderCount;
	}

	// Session operations
	async compact(customInstructions?: string): Promise<void> {
		await this._post("compact", { customInstructions });
	}

	setModel(modelId: string): void {
		this._post("set-model", { modelId }).catch((e: Error) => {
			process.stderr.write(`[connect] setModel failed: ${e.message}\n`);
		});
	}

	cycleModel(direction: 1 | -1): void {
		this._post("cycle-model", { direction }).catch((e: Error) => {
			process.stderr.write(`[connect] cycleModel failed: ${e.message}\n`);
		});
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this._post("set-thinking-level", { level }).catch((e: Error) => {
			process.stderr.write(`[connect] setThinkingLevel failed: ${e.message}\n`);
		});
	}

	cycleThinkingLevel(direction: 1 | -1): void {
		this._post("cycle-thinking-level", { direction }).catch((e: Error) => {
			process.stderr.write(`[connect] cycleThinkingLevel failed: ${e.message}\n`);
		});
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this._post("settings", { autoCompact: enabled }).catch((e: Error) => {
			process.stderr.write(`[connect] setAutoCompactEnabled failed: ${e.message}\n`);
		});
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._post("settings", { steeringMode: mode }).catch((e: Error) => {
			process.stderr.write(`[connect] setSteeringMode failed: ${e.message}\n`);
		});
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._post("settings", { followUpMode: mode }).catch((e: Error) => {
			process.stderr.write(`[connect] setFollowUpMode failed: ${e.message}\n`);
		});
	}

	// Runtime operations
	async newSession(): Promise<void> {
		await this._post("new-session");
	}

	async switchSession(sessionFile: string): Promise<void> {
		await this._post("switch-session", { sessionFile });
	}

	async fork(entryId?: string): Promise<void> {
		await this._post("fork", { entryId });
	}

	renameSession(name: string): void {
		this._post("name", { name }).catch((e: Error) => {
			process.stderr.write(`[connect] renameSession failed: ${e.message}\n`);
		});
	}

	setLabel(entryId: string, label: string | undefined): void {
		this._post("label", { entryId, label }).catch((e: Error) => {
			process.stderr.write(`[connect] setLabel failed: ${e.message}\n`);
		});
	}

	setScopedModels(enabledIds: string[] | null): void {
		this._post("scoped-models", { enabledIds }).catch((e: Error) => {
			process.stderr.write(`[connect] setScopedModels failed: ${e.message}\n`);
		});
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this._post("enabled-models", { patterns }).catch((e: Error) => {
			process.stderr.write(`[connect] setEnabledModels failed: ${e.message}\n`);
		});
	}

	updateSettings(updates: Record<string, unknown>): void {
		this._post("settings", updates).catch((e: Error) => {
			process.stderr.write(`[connect] updateSettings failed: ${e.message}\n`);
		});
	}

	async reload(): Promise<void> {
		await this._post("reload");
	}

	// Data queries
	getTree(): TreeNodeData[] {
		// Fetch synchronously from cached snapshot or fetch on demand
		// For now, we'll fetch via a separate GET request
		throw new Error("Use fetchTree() for async tree data");
	}

	async fetchTree(): Promise<TreeNodeData[]> {
		const response = await fetch(`${this._baseUrl}/tree`);
		return (await response.json()) as TreeNodeData[];
	}

	getUserMessagesForForking(): UserMessageItem[] {
		throw new Error("Use fetchUserMessages() for async data");
	}

	async fetchUserMessages(): Promise<UserMessageItem[]> {
		const response = await fetch(`${this._baseUrl}/user-messages`);
		return (await response.json()) as UserMessageItem[];
	}

	async getSessions(): Promise<SessionItemData[]> {
		const response = await fetch(`${this._baseUrl}/sessions`);
		return (await response.json()) as SessionItemData[];
	}

	getCommands(): ServeSlashCommand[] {
		throw new Error("Use fetchCommands() for async data");
	}

	async fetchCommands(): Promise<ServeSlashCommand[]> {
		const response = await fetch(`${this._baseUrl}/commands`);
		return (await response.json()) as ServeSlashCommand[];
	}

	getModels(): ModelItemData[] {
		throw new Error("Use fetchModels() for async data");
	}

	async fetchModels(): Promise<ModelItemData[]> {
		const response = await fetch(`${this._baseUrl}/models`);
		return (await response.json()) as ModelItemData[];
	}

	// Lifecycle
	dispose(): void {
		this._sseClient.disconnect();
	}

	// Snapshot
	getSnapshot(): SessionStateSnapshot {
		return { ...this._state };
	}
}
