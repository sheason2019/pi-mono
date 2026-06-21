import type {
	DPiInteractiveAgentSessionEvent,
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveClientExtensionData,
	DPiInteractiveModelItemData,
	DPiInteractiveProxyPromptOptions,
	DPiInteractiveSessionItemData,
	DPiInteractiveSessionStateSnapshot,
	DPiInteractiveSlashCommand,
	DPiInteractiveTreeNodeData,
	DPiInteractiveUserMessageItem,
} from "./agent-session-proxy.ts";
import {
	applyDPiInteractiveRealtimeEvent,
	composeDPiInteractiveSnapshot,
	type DPiInteractiveRealtimeState,
	type DPiInteractiveStatusState,
	isDPiInteractiveRealtimeEvent,
	isDPiInteractiveRealtimeState,
	isDPiInteractiveStatusState,
	splitDPiInteractiveSnapshot,
} from "./view-model.ts";

type Listener = (event: DPiInteractiveAgentSessionEvent) => void;

export interface DPiInteractiveRemoteAgentSessionProxyOptions {
	baseUrl: string;
	headers?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
}

export class DPiInteractiveRemoteAgentSessionProxy implements DPiInteractiveAgentSessionProxy {
	private readonly baseUrl: string;
	private readonly headers: Readonly<Record<string, string>>;
	private readonly fetchFn: typeof fetch;
	private readonly listeners = new Set<Listener>();
	private statusState: DPiInteractiveStatusState;
	private realtimeState: DPiInteractiveRealtimeState;
	private eventsAbortController: AbortController | undefined;

	constructor(
		initialStatus: DPiInteractiveSessionStateSnapshot | DPiInteractiveStatusState,
		realtimeOrOptions: DPiInteractiveRealtimeState | DPiInteractiveRemoteAgentSessionProxyOptions,
		maybeOptions?: DPiInteractiveRemoteAgentSessionProxyOptions,
	) {
		if (maybeOptions) {
			this.statusState = initialStatus as DPiInteractiveStatusState;
			this.realtimeState = realtimeOrOptions as DPiInteractiveRealtimeState;
		} else {
			const split = splitDPiInteractiveSnapshot(initialStatus as DPiInteractiveSessionStateSnapshot);
			this.statusState = split.status;
			this.realtimeState = split.realtime;
		}
		const options = maybeOptions ?? (realtimeOrOptions as DPiInteractiveRemoteAgentSessionProxyOptions);
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.headers = options.headers ?? {};
		this.fetchFn = options.fetch ?? fetch;
	}

	async connect(): Promise<void> {
		const controller = new AbortController();
		const response = await this.fetchFn(`${this.baseUrl}/events`, {
			headers: this.headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`GET /events returned HTTP ${response.status}`);
		}
		if (!response.body) {
			throw new Error("GET /events returned an empty body");
		}
		this.eventsAbortController = controller;
		void this.pumpEvents(response.body, controller.signal);
	}

	disconnect(): void {
		this.eventsAbortController?.abort();
		this.eventsAbortController = undefined;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string, options?: DPiInteractiveProxyPromptOptions): Promise<void> {
		await this.post("prompt", { text, ...(options === undefined ? {} : { options }) });
	}

	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		void this.post("steer", { text, ...(images === undefined ? {} : { images }) });
	}

	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		void this.post("follow-up", { text, ...(images === undefined ? {} : { images }) });
	}

	abort(): void {
		void this.post("abort");
	}

	abortBash(): void {
		void this.post("abort-bash");
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const dropped = {
			steering: [...this.statusState.steeringMessages],
			followUp: [...this.statusState.followUpMessages],
		};
		void this.post("clear-queue");
		this.statusState = { ...this.statusState, steeringMessages: [], followUpMessages: [] };
		return dropped;
	}

	get model(): string {
		return this.statusState.model;
	}
	get thinkingLevel(): DPiInteractiveSessionStateSnapshot["thinkingLevel"] {
		return this.statusState.thinkingLevel;
	}
	get isStreaming(): boolean {
		return this.statusState.isStreaming;
	}
	get isCompacting(): boolean {
		return this.statusState.isCompacting;
	}
	get isBashRunning(): boolean {
		return this.statusState.isBashRunning;
	}
	get steeringMessages(): readonly string[] {
		return this.statusState.steeringMessages;
	}
	get followUpMessages(): readonly string[] {
		return this.statusState.followUpMessages;
	}
	get sessionFile(): string | undefined {
		return this.statusState.sessionFile;
	}
	get sessionName(): string | undefined {
		return this.statusState.sessionName;
	}
	get messages(): DPiInteractiveSessionStateSnapshot["messages"] {
		return this.realtimeState.messages as DPiInteractiveSessionStateSnapshot["messages"];
	}

	async compact(customInstructions?: string): Promise<void> {
		await this.post("compact", { customInstructions });
	}
	setModel(modelId: string): void {
		void this.post("set-model", { modelId });
	}
	cycleModel(direction: 1 | -1): void {
		void this.post("cycle-model", { direction });
	}
	setThinkingLevel(level: DPiInteractiveSessionStateSnapshot["thinkingLevel"]): void {
		void this.post("set-thinking-level", { level });
	}
	cycleThinkingLevel(direction: 1 | -1): void {
		void this.post("cycle-thinking-level", { direction });
	}
	setAutoCompactEnabled(enabled: boolean): void {
		void this.post("settings", { autoCompact: enabled });
	}
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		void this.post("settings", { steeringMode: mode });
	}
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		void this.post("settings", { followUpMode: mode });
	}
	async newSession(): Promise<void> {
		await this.post("new-session");
	}
	async switchSession(sessionFile: string): Promise<void> {
		await this.post("switch-session", { sessionFile });
	}
	async fork(entryId?: string): Promise<void> {
		await this.post("fork", { entryId });
	}
	renameSession(name: string): void {
		void this.post("name", { name });
	}
	setLabel(entryId: string, label: string | undefined): void {
		void this.post("label", { entryId, label });
	}
	async reload(): Promise<void> {
		await this.post("reload");
	}
	setScopedModels(enabledIds: string[] | null): void {
		void this.post("scoped-models", { enabledIds });
	}
	setEnabledModels(patterns: string[] | undefined): void {
		void this.post("enabled-models", { patterns });
	}
	updateSettings(updates: Record<string, unknown>): void {
		void this.post("settings", updates);
	}
	getTree(): DPiInteractiveTreeNodeData[] {
		return [];
	}
	getUserMessagesForForking(): DPiInteractiveUserMessageItem[] {
		return [];
	}
	async getSessions(): Promise<DPiInteractiveSessionItemData[]> {
		return this.getJson("sessions");
	}
	async fetchTree(): Promise<DPiInteractiveTreeNodeData[]> {
		return this.getJson("tree");
	}
	async fetchUserMessagesForForking(): Promise<DPiInteractiveUserMessageItem[]> {
		return this.getJson("user-messages");
	}
	async fetchCommands(): Promise<DPiInteractiveSlashCommand[]> {
		return this.getJson("commands");
	}
	getCommands(): DPiInteractiveSlashCommand[] {
		return [];
	}
	async fetchModels(): Promise<DPiInteractiveModelItemData[]> {
		return this.getJson("models");
	}
	getModels(): DPiInteractiveModelItemData[] {
		return [];
	}
	async fetchClientExtensions(): Promise<DPiInteractiveClientExtensionData[]> {
		return this.getJson("client-extensions");
	}
	getClientExtensions(): DPiInteractiveClientExtensionData[] {
		return [];
	}
	getSnapshot(): DPiInteractiveSessionStateSnapshot {
		return composeDPiInteractiveSnapshot(this.statusState, this.realtimeState);
	}

	private async post(endpoint: string, body?: unknown): Promise<void> {
		const response = await this.fetchFn(`${this.baseUrl}/${endpoint}`, {
			method: "POST",
			headers: { ...this.headers, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`${endpoint} returned HTTP ${response.status}`);
		}
	}

	private async getJson<T>(endpoint: string): Promise<T> {
		const response = await this.fetchFn(`${this.baseUrl}/${endpoint}`, { headers: this.headers });
		if (!response.ok) {
			throw new Error(`${endpoint} returned HTTP ${response.status}`);
		}
		return (await response.json()) as T;
	}

	private async pumpEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		for await (const event of parseNamedSseEvents(body)) {
			if (signal.aborted) {
				return;
			}
			this.applyNamedEvent(event);
		}
	}

	private applyNamedEvent(event: NamedSseEvent): void {
		const data = parseSseEventData(event.data);
		if (event.event === "status" && isDPiInteractiveStatusState(data)) {
			this.statusState = data;
			this.emit({ type: "state_update", snapshot: data });
			return;
		}
		if (event.event === "realtime" && isDPiInteractiveRealtimeEvent(data)) {
			this.realtimeState = applyDPiInteractiveRealtimeEvent(this.realtimeState, data);
			if (data.type === "upsert") {
				this.emit({
					type: "message_update",
					message: data.message as DPiInteractiveSessionStateSnapshot["messages"][number],
				});
			} else {
				this.emit({
					type: "state_update",
					snapshot: {
						messages: this.realtimeState.messages as DPiInteractiveSessionStateSnapshot["messages"],
					},
				});
			}
			return;
		}
		if (event.event === "state" && isInteractiveSnapshot(data)) {
			const split = splitDPiInteractiveSnapshot(data);
			this.statusState = split.status;
			this.realtimeState = split.realtime;
			this.emit({ type: "state_update", snapshot: data });
			return;
		}
		if (event.event === "turn_stats" && isTurnStats(data)) {
			this.emit({ type: "turn_stats", ...data });
			return;
		}
		if (data === undefined && isPayloadLessInteractiveEventType(event.event)) {
			this.applyEvent({ type: event.event });
			this.emit({ type: event.event });
			return;
		}
		if (isInteractiveEvent(data)) {
			this.applyEvent(data);
			this.emit(data);
		}
	}

	private applyEvent(event: DPiInteractiveAgentSessionEvent): void {
		if (event.type === "state_update" && event.snapshot) {
			const { messages, ...statusPatch } = event.snapshot;
			this.statusState = { ...this.statusState, ...statusPatch };
			if (messages) {
				this.realtimeState = { ...this.realtimeState, messages: messages as typeof this.realtimeState.messages };
			}
		} else if (event.type === "agent_start") {
			this.statusState = { ...this.statusState, isStreaming: true };
		} else if (event.type === "agent_end") {
			this.statusState = { ...this.statusState, isStreaming: false };
		} else if (event.type === "compaction_start") {
			this.statusState = { ...this.statusState, isCompacting: true };
		} else if (event.type === "compaction_end") {
			this.statusState = { ...this.statusState, isCompacting: false };
		} else if (event.type === "queue_update") {
			this.statusState = { ...this.statusState, steeringMessages: event.steering, followUpMessages: event.followUp };
		}
	}

	private emit(event: DPiInteractiveAgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	applyNamedEventForTest(event: NamedSseEvent): void {
		this.applyNamedEvent(event);
	}
}

export async function createDPiInteractiveRemoteAgentSessionProxy(
	options: DPiInteractiveRemoteAgentSessionProxyOptions,
): Promise<DPiInteractiveRemoteAgentSessionProxy> {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const fetchFn = options.fetch ?? fetch;
	const statusResponse = await fetchFn(`${baseUrl}/status`, {
		headers: options.headers,
	});
	if (!statusResponse.ok) {
		throw new Error(`GET /status returned HTTP ${statusResponse.status}`);
	}
	const status = (await statusResponse.json()) as unknown;
	if (!isDPiInteractiveStatusState(status)) {
		throw new Error("GET /status returned an invalid interactive status state");
	}
	const realtimeResponse = await fetchFn(`${baseUrl}/realtime`, {
		headers: options.headers,
	});
	if (!realtimeResponse.ok) {
		throw new Error(`GET /realtime returned HTTP ${realtimeResponse.status}`);
	}
	const realtime = (await realtimeResponse.json()) as unknown;
	if (!isDPiInteractiveRealtimeState(realtime)) {
		throw new Error("GET /realtime returned an invalid interactive realtime state");
	}
	return new DPiInteractiveRemoteAgentSessionProxy(status, realtime, options);
}

interface NamedSseEvent {
	event: string;
	data: string;
}

async function* parseNamedSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<NamedSseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const read = await reader.read();
			if (read.done) {
				break;
			}
			buffer += decoder.decode(read.value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = parseNamedSseBlock(raw);
				if (event) {
					yield event;
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseNamedSseBlock(raw: string): NamedSseEvent | undefined {
	let event = "message";
	const data: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("event:")) {
			event = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			data.push(line.slice(5).trimStart());
		}
	}
	return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

function parseSseEventData(data: string): unknown {
	const trimmed = data.trim();
	if (!trimmed || trimmed === "undefined") {
		return undefined;
	}
	return JSON.parse(data) as unknown;
}

function isInteractiveSnapshot(value: unknown): value is DPiInteractiveSessionStateSnapshot {
	return (
		typeof value === "object" &&
		value !== null &&
		"messages" in value &&
		"tokenUsage" in value &&
		"contextUsage" in value &&
		"remoteSettings" in value
	);
}

function isInteractiveEvent(value: unknown): value is DPiInteractiveAgentSessionEvent {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function isPayloadLessInteractiveEventType(
	value: string,
): value is Extract<DPiInteractiveAgentSessionEvent, { type: "compaction_end" | "compaction_start" }>["type"] {
	return value === "compaction_start" || value === "compaction_end";
}

function isTurnStats(
	value: unknown,
): value is Omit<Extract<DPiInteractiveAgentSessionEvent, { type: "turn_stats" }>, "type"> {
	return (
		typeof value === "object" &&
		value !== null &&
		"tps" in value &&
		"output" in value &&
		"input" in value &&
		"cacheRead" in value &&
		"cacheWrite" in value &&
		"total" in value &&
		"duration" in value
	);
}
