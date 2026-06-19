import type {
	DPiInteractiveAgentSessionEvent,
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveModelItemData,
	DPiInteractiveProxyPromptOptions,
	DPiInteractiveSessionItemData,
	DPiInteractiveSessionStateSnapshot,
	DPiInteractiveSlashCommand,
	DPiInteractiveTreeNodeData,
	DPiInteractiveUserMessageItem,
} from "./agent-session-proxy.ts";

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
	private state: DPiInteractiveSessionStateSnapshot;
	private eventsAbortController: AbortController | undefined;

	constructor(
		initialState: DPiInteractiveSessionStateSnapshot,
		options: DPiInteractiveRemoteAgentSessionProxyOptions,
	) {
		this.state = initialState;
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
		const dropped = { steering: [...this.state.steeringMessages], followUp: [...this.state.followUpMessages] };
		void this.post("clear-queue");
		this.state = { ...this.state, steeringMessages: [], followUpMessages: [] };
		return dropped;
	}

	get model(): string {
		return this.state.model;
	}
	get thinkingLevel(): DPiInteractiveSessionStateSnapshot["thinkingLevel"] {
		return this.state.thinkingLevel;
	}
	get isStreaming(): boolean {
		return this.state.isStreaming;
	}
	get isCompacting(): boolean {
		return this.state.isCompacting;
	}
	get isBashRunning(): boolean {
		return this.state.isBashRunning;
	}
	get steeringMessages(): readonly string[] {
		return this.state.steeringMessages;
	}
	get followUpMessages(): readonly string[] {
		return this.state.followUpMessages;
	}
	get sessionFile(): string | undefined {
		return this.state.sessionFile;
	}
	get sessionName(): string | undefined {
		return this.state.sessionName;
	}
	get messages(): DPiInteractiveSessionStateSnapshot["messages"] {
		return this.state.messages;
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
	getCommands(): DPiInteractiveSlashCommand[] {
		return [];
	}
	getModels(): DPiInteractiveModelItemData[] {
		return [];
	}
	getSnapshot(): DPiInteractiveSessionStateSnapshot {
		return this.state;
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
		const data = event.data ? (JSON.parse(event.data) as unknown) : undefined;
		if (event.event === "state" && isInteractiveSnapshot(data)) {
			this.state = data;
			this.emit({ type: "state_update", snapshot: data });
			return;
		}
		if (event.event === "turn_stats" && isTurnStats(data)) {
			this.emit({ type: "turn_stats", ...data });
			return;
		}
		if (isInteractiveEvent(data)) {
			this.applyEvent(data);
			this.emit(data);
		}
	}

	private applyEvent(event: DPiInteractiveAgentSessionEvent): void {
		if (event.type === "state_update" && event.snapshot) {
			this.state = { ...this.state, ...event.snapshot };
		} else if (event.type === "agent_start") {
			this.state = { ...this.state, isStreaming: true };
		} else if (event.type === "agent_end") {
			this.state = { ...this.state, isStreaming: false };
		} else if (event.type === "queue_update") {
			this.state = { ...this.state, steeringMessages: event.steering, followUpMessages: event.followUp };
		}
	}

	private emit(event: DPiInteractiveAgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

export async function createDPiInteractiveRemoteAgentSessionProxy(
	options: DPiInteractiveRemoteAgentSessionProxyOptions,
): Promise<DPiInteractiveRemoteAgentSessionProxy> {
	const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/+$/, "")}/state`, {
		headers: options.headers,
	});
	if (!response.ok) {
		throw new Error(`GET /state returned HTTP ${response.status}`);
	}
	const snapshot = (await response.json()) as unknown;
	if (!isInteractiveSnapshot(snapshot)) {
		throw new Error("GET /state returned an invalid interactive snapshot");
	}
	return new DPiInteractiveRemoteAgentSessionProxy(snapshot, options);
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
