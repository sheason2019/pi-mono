import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type {
	AgentSessionProxy,
	ContextUsageInfo,
	ModelInfo,
	ModelItemData,
	ProxyPromptOptions,
	ServeSlashCommand,
	SessionItemData,
	SessionStateSnapshot,
	TokenUsage,
	TreeNodeData,
	UserMessageItem,
} from "../../core/agent-session-proxy.ts";
import type { ConnectAuthHeaders } from "./auth-headers.ts";
import { SseClient } from "./sse-client.ts";

type Listener = (event: AgentSessionEvent) => void;
type DisconnectCallback = (reason: string) => void;

export class RemoteAgentSessionProxy implements AgentSessionProxy {
	private _state: SessionStateSnapshot;
	private readonly _subscribers: Set<Listener> = new Set();
	private readonly _sseClient: SseClient;
	private readonly _baseUrl: string;
	private readonly _onDisconnect: DisconnectCallback | undefined;
	private readonly _headers: ConnectAuthHeaders | undefined;

	constructor(
		baseUrl: string,
		initialState: SessionStateSnapshot,
		onDisconnect?: DisconnectCallback,
		options: { headers?: ConnectAuthHeaders } = {},
	) {
		this._baseUrl = baseUrl;
		this._state = initialState;
		this._onDisconnect = onDisconnect;
		this._headers = options.headers;

		this._sseClient = new SseClient(
			`${baseUrl}/events`,
			this._headers,
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
		// For session_replaced, fetch fresh state BEFORE notifying subscribers
		if (event.type === "session_replaced") {
			this._state = { ...this._state, messages: [] };
			this._fetchState()
				.then(() => {
					for (const subscriber of this._subscribers) {
						subscriber(event);
					}
				})
				.catch((e: Error) => {
					process.stderr.write(`[connect] failed to fetch state after session_replaced: ${e.message}\n`);
					// Still notify subscribers even on failure so UI resets
					for (const subscriber of this._subscribers) {
						subscriber(event);
					}
				});
			return;
		}
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

	/** Fetch full state snapshot from server and update local cache */
	private async _fetchState(): Promise<void> {
		const response = await fetch(`${this._baseUrl}/state`, { headers: this._headers });
		if (!response.ok) {
			throw new Error(`GET /state returned HTTP ${response.status}`);
		}
		const snapshot = (await response.json()) as SessionStateSnapshot;
		this._state = snapshot;
	}

	private async _post(endpoint: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${this._baseUrl}/${endpoint}`, {
			method: "POST",
			headers: { ...this._headers, "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await response.json();
		if (!response.ok) {
			throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
		}
		return data;
	}

	/** GET {endpoint} and return parsed JSON. Throws with status + server error
	 *  body on non-2xx, so callers see the real cause instead of a misleading
	 *  downstream failure (e.g. `.map is not a function` on a JSON object). */
	private async _getJson<T>(endpoint: string): Promise<T> {
		const response = await fetch(`${this._baseUrl}/${endpoint}`, { headers: this._headers });
		if (!response.ok) {
			let detail = "";
			try {
				const body = (await response.json()) as { error?: unknown };
				if (body && typeof body === "object" && "error" in body) {
					detail = `: ${String(body.error)}`;
				}
			} catch {
				// body was not JSON; leave detail empty
			}
			throw new Error(`${endpoint} returned ${response.status}${detail}`);
		}
		return (await response.json()) as T;
	}

	// Event subscription
	subscribe(listener: Listener): () => void {
		this._subscribers.add(listener);
		return () => {
			this._subscribers.delete(listener);
		};
	}

	// Commands
	async prompt(text: string, options?: ProxyPromptOptions): Promise<void> {
		await this._post("prompt", { text, options });
	}

	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		this._post("prompt", { text, options: { images, streamingBehavior: "steer" } }).catch((e: Error) => {
			process.stderr.write(`[connect] steer failed: ${e.message}\n`);
		});
	}

	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		this._post("prompt", { text, options: { images, streamingBehavior: "followUp" } }).catch((e: Error) => {
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

	/**
	 * Clear the server-side steering + follow-up queues. Synchronous
	 * return shape matches the local proxy: snapshot what the TUI is
	 * currently showing, then fire-and-forget the server-side clear.
	 *
	 * The returned snapshots are from the most recent `state_update`
	 * SSE event (or the initial `/state` fetch on connect). They may
	 * be slightly stale relative to the server's true queue if more
	 * messages arrived in the gap between the snapshot and this call,
	 * but in practice the TUI is the one driving the editor and the
	 * gap is sub-frame. If the user is editing the same messages on
	 * the server side via a second connect client, the second
	 * client's edit will be reflected in the next `state_update` event
	 * — there's no commit-collision logic for queued messages, and
	 * the editor shows what the user typed, not what the server has.
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const snapshot = {
			steering: [...this._state.steeringMessages],
			followUp: [...this._state.followUpMessages],
		};
		// Fire-and-forget the server-side clear. We don't await because
		// the interface is sync; the caller's promise chain (e.g. the
		// TUI's `restoreQueuedMessagesToEditor`) doesn't depend on the
		// server's confirmation — it just needs the local snapshot to
		// put into the editor. If the POST fails, stderr is the only
		// signal (matching how other void proxy methods behave).
		this._post("clear-queue")
			.then(() => {
				// Wipe the local cache so subsequent state_update events
				// don't re-show the messages we just removed.
				this._state = { ...this._state, steeringMessages: [], followUpMessages: [] };
			})
			.catch((e: Error) => {
				process.stderr.write(`[connect] clearQueue failed: ${e.message}\n`);
			});
		return snapshot;
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
		return this._getJson<TreeNodeData[]>("tree");
	}

	getUserMessagesForForking(): UserMessageItem[] {
		throw new Error("Use fetchUserMessages() for async data");
	}

	async fetchUserMessages(): Promise<UserMessageItem[]> {
		return this._getJson<UserMessageItem[]>("user-messages");
	}

	async getSessions(): Promise<SessionItemData[]> {
		return this._getJson<SessionItemData[]>("sessions");
	}

	getCommands(): ServeSlashCommand[] {
		throw new Error("Use fetchCommands() for async data");
	}

	async fetchCommands(): Promise<ServeSlashCommand[]> {
		return this._getJson<ServeSlashCommand[]>("commands");
	}

	getModels(): ModelItemData[] {
		throw new Error("Use fetchModels() for async data");
	}

	async fetchModels(): Promise<ModelItemData[]> {
		return this._getJson<ModelItemData[]>("models");
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
