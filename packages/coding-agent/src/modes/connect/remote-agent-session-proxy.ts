import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionProxy, SessionStateSnapshot } from "../../core/agent-session-proxy.ts";
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

	// Runtime operations
	async newSession(): Promise<void> {
		await this._post("new-session");
	}

	async switchSession(sessionFile: string): Promise<void> {
		await this._post("switch-session", { sessionFile });
	}

	async fork(entryIndex?: number): Promise<void> {
		await this._post("fork", { entryIndex });
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
