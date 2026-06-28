import type {
	DPiInteractiveAgentSessionEvent,
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveModelItemData,
	DPiInteractiveProxyPromptOptions,
	DPiInteractiveSessionItemData,
	DPiInteractiveSessionStateSnapshot,
	DPiInteractiveSlashCommand,
	DPiInteractiveTodoItem,
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
			this.statusState = ensurePlanInStatus(initialStatus as DPiInteractiveStatusState);
			this.realtimeState = realtimeOrOptions as DPiInteractiveRealtimeState;
		} else {
			const split = splitDPiInteractiveSnapshot(initialStatus as DPiInteractiveSessionStateSnapshot);
			this.statusState = ensurePlanInStatus(split.status);
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
		void this.post("steer", { text, ...(images === undefined ? {} : { images }) });
	}

	abort(): void {
		void this.post("abort");
	}

	clearQueue(): { steering: string[] } {
		const dropped = {
			steering: [...this.statusState.steeringMessages],
		};
		void this.post("clear-queue");
		this.statusState = { ...this.statusState, steeringMessages: [] };
		return dropped;
	}

	get model(): string {
		return this.statusState.model;
	}
	get isStreaming(): boolean {
		return this.statusState.isStreaming;
	}
	get isCompacting(): boolean {
		return this.statusState.isCompacting;
	}
	get steeringMessages(): readonly string[] {
		return this.statusState.steeringMessages;
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
			const message = await responseErrorMessage(response);
			throw new Error(`${endpoint} returned HTTP ${response.status}${message ? `: ${message}` : ""}`);
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
			this.statusState = ensurePlanInStatus(data);
			this.emit({ type: "state_update", snapshot: this.statusState });
			return;
		}
		if (event.event === "realtime" && isDPiInteractiveRealtimeEvent(data)) {
			this.realtimeState = applyDPiInteractiveRealtimeEvent(this.realtimeState, data);
			if (data.type === "upsert" && data.message) {
				this.emit({
					type: "message_update",
					message: data.message as DPiInteractiveSessionStateSnapshot["messages"][number],
				});
			} else {
				this.emit({
					type: "state_update",
					snapshot: {
						messages: this.realtimeState.messages as DPiInteractiveSessionStateSnapshot["messages"],
						...(this.realtimeState.items.length > 0 ? { transcriptItems: [...this.realtimeState.items] } : {}),
					},
				});
			}
			return;
		}
		if (event.event === "state" && isInteractiveSnapshot(data)) {
			const split = splitDPiInteractiveSnapshot(data);
			this.statusState = ensurePlanInStatus(split.status);
			this.realtimeState = split.realtime;
			this.emit({ type: "state_update", snapshot: data });
			return;
		}
		if (event.event === "turn_stats" && isTurnStats(data)) {
			this.emit({ type: "turn_stats", ...data });
			return;
		}
		if (event.event === "plan" && isTodoList(data)) {
			this.statusState = { ...this.statusState, plan: data };
			this.emit({ type: "plan_update", plan: data });
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
			this.statusState = { ...this.statusState, steeringMessages: event.steering };
		} else if (event.type === "plan_update") {
			this.statusState = { ...this.statusState, plan: event.plan };
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

async function responseErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.clone().json()) as unknown;
		if (typeof body === "object" && body !== null && "error" in body) {
			const error = (body as { error?: unknown }).error;
			if (typeof error === "string") {
				return error;
			}
			if (typeof error === "object" && error !== null && "message" in error) {
				const message = (error as { message?: unknown }).message;
				return typeof message === "string" ? message : undefined;
			}
		}
	} catch {
		try {
			const text = await response.text();
			return text.trim() || undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
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

function isTodoList(value: unknown): value is DPiInteractiveTodoItem[] {
	if (!Array.isArray(value)) {
		return false;
	}
	return value.every((item) => {
		if (typeof item !== "object" || item === null) {
			return false;
		}
		const rec = item as Record<string, unknown>;
		return (
			typeof rec.id === "string" &&
			typeof rec.content === "string" &&
			["pending", "in_progress", "completed"].includes(rec.status as string) &&
			(!("summary" in rec) || typeof rec.summary === "string" || rec.summary === undefined)
		);
	});
}

function ensurePlanInStatus(status: DPiInteractiveStatusState): DPiInteractiveStatusState {
	if (Array.isArray(status.plan)) {
		return status;
	}
	return { ...status, plan: [] };
}
