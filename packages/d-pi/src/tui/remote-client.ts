import {
	type DPiJsonValue,
	type DPiServiceActionRequest,
	type DPiServiceError,
	type DPiServiceEvent,
	type DPiServiceSnapshot,
	isDPiJsonValue,
	isDPiServiceError,
	isDPiServiceSnapshot,
} from "../service/protocol.ts";
import { isRecord } from "../shared/schemas.ts";

export type DPiRemoteClientEventListener = (event: DPiServiceEvent) => void;
export type DPiRemoteClientUnsubscribe = () => void;

export interface DPiRemoteClientOptions {
	baseUrl: string;
	agentName: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
}

export interface DPiRemoteClientConnectOptions {
	subscribe?: boolean;
}

export class DPiRemoteClientError extends Error {
	readonly name = "DPiRemoteClientError";
	readonly code: string;
	readonly status: number;
	readonly details: DPiJsonValue | undefined;

	constructor(code: string, message: string, status: number, details?: DPiJsonValue) {
		super(message);
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export class DPiRemoteClient {
	private readonly baseUrl: string;
	private readonly authHeaders: Readonly<Record<string, string>>;
	private readonly fetchFn: typeof fetch;
	private agentName: string;
	private snapshot: DPiServiceSnapshot | undefined;
	private events: DPiServiceEvent[] = [];
	private errors: unknown[] = [];
	private readonly listeners = new Set<DPiRemoteClientEventListener>();
	private eventAbortController: AbortController | undefined;

	constructor(options: DPiRemoteClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.agentName = options.agentName;
		this.authHeaders = options.authHeaders ?? {};
		this.fetchFn = options.fetch ?? fetch;
	}

	getSnapshot(): DPiServiceSnapshot | undefined {
		return this.snapshot;
	}

	getEvents(): readonly DPiServiceEvent[] {
		return [...this.events];
	}

	getErrors(): readonly unknown[] {
		return [...this.errors];
	}

	onEvent(listener: DPiRemoteClientEventListener): DPiRemoteClientUnsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async connect(options: DPiRemoteClientConnectOptions = {}): Promise<void> {
		this.disconnect();
		this.events = [];
		this.snapshot = await this.fetchSnapshot();
		if (options.subscribe === true) {
			await this.subscribe();
		}
	}

	disconnect(): void {
		this.eventAbortController?.abort();
		this.eventAbortController = undefined;
	}

	async setAgentName(agentName: string, options: DPiRemoteClientConnectOptions = {}): Promise<void> {
		const wasSubscribed = this.eventAbortController !== undefined;
		this.agentName = agentName;
		await this.connect({ subscribe: options.subscribe ?? wasSubscribed });
	}

	async prompt(text: string, options?: DPiJsonValue): Promise<void> {
		await this.sendAction("prompt", { text, ...(options === undefined ? {} : { options }) });
	}

	async steer(text: string, options?: DPiJsonValue): Promise<void> {
		await this.sendAction("steer", { text, ...(options === undefined ? {} : { options }) });
	}

	async followUp(text: string, options?: DPiJsonValue): Promise<void> {
		await this.sendAction("follow-up", { text, ...(options === undefined ? {} : { options }) });
	}

	private async fetchSnapshot(): Promise<DPiServiceSnapshot> {
		const response = await this.fetchFn(this.serviceUrl("snapshot"), {
			headers: this.headers(),
		});
		const body = await readJson(response);
		throwIfServiceError(body, response.status);
		if (!response.ok) {
			throw new DPiRemoteClientError(
				"http_error",
				`Remote service returned HTTP ${response.status}`,
				response.status,
			);
		}
		if (!isDPiServiceSnapshot(body)) {
			throw new DPiRemoteClientError(
				"invalid_response",
				"Remote service returned an invalid snapshot",
				response.status,
			);
		}
		return body;
	}

	private async subscribe(): Promise<void> {
		const controller = new AbortController();
		const response = await this.fetchFn(this.serviceUrl("events"), {
			headers: this.headers(),
			signal: controller.signal,
		});
		const body = await readJsonOrUndefined(response);
		if (body !== undefined) {
			throwIfServiceError(body, response.status);
		}
		if (!response.ok) {
			throw new DPiRemoteClientError(
				"http_error",
				`Remote service returned HTTP ${response.status}`,
				response.status,
			);
		}
		if (!response.body) {
			throw new DPiRemoteClientError(
				"invalid_response",
				"Remote service returned an empty event stream",
				response.status,
			);
		}
		this.eventAbortController = controller;
		void this.pumpEvents(response.body, controller.signal).catch((error: unknown) => {
			if (!controller.signal.aborted) {
				this.recordError(error);
			}
		});
	}

	private async sendAction(action: "prompt" | "steer" | "follow-up", request: DPiServiceActionRequest): Promise<void> {
		const response = await this.fetchFn(this.serviceUrl(`actions/${action}`), {
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify(request),
		});
		const body = await readJson(response);
		throwIfServiceError(body, response.status);
		if (!response.ok) {
			throw new DPiRemoteClientError(
				"http_error",
				`Remote service returned HTTP ${response.status}`,
				response.status,
			);
		}
		if (!isRecord(body) || body.ok !== true) {
			throw new DPiRemoteClientError(
				"invalid_response",
				"Remote service returned an invalid action result",
				response.status,
			);
		}
	}

	private async pumpEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const chunk of parseSseEvents(body)) {
				if (signal.aborted) {
					return;
				}
				try {
					const event = parseServiceEvent(chunk.data);
					this.applyEvent(event);
				} catch (error) {
					if (!signal.aborted) {
						this.recordError(error);
					}
				}
			}
		} catch (error) {
			if (!signal.aborted) {
				this.recordError(error);
			}
		}
	}

	private applyEvent(event: DPiServiceEvent): void {
		if (event.type === "snapshot") {
			this.snapshot = event.snapshot;
		} else {
			this.events = [...this.events, event];
		}
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				this.recordError(error);
			}
		}
	}

	private recordError(error: unknown): void {
		this.errors = [...this.errors, error];
	}

	private serviceUrl(path: string): string {
		return `${this.baseUrl}/api/agents/${encodeURIComponent(this.agentName)}/${path}`;
	}

	private headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
		return {
			...this.authHeaders,
			...extra,
		};
	}
}

interface ParsedSseEvent {
	data: string;
}

async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSseEvent> {
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
			let boundary = findSseBoundary(buffer);
			while (boundary !== undefined) {
				const rawEvent = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				const event = parseSseBlock(rawEvent);
				if (event !== undefined) {
					yield event;
				}
				boundary = findSseBoundary(buffer);
			}
		}
		buffer += decoder.decode();
		const event = parseSseBlock(buffer);
		if (event !== undefined) {
			yield event;
		}
	} finally {
		reader.releaseLock();
	}
}

function findSseBoundary(buffer: string): { index: number; length: number } | undefined {
	const boundaries = [
		{ index: buffer.indexOf("\n\n"), length: 2 },
		{ index: buffer.indexOf("\r\r"), length: 2 },
		{ index: buffer.indexOf("\r\n\r\n"), length: 4 },
	].filter((boundary) => boundary.index !== -1);
	if (boundaries.length === 0) {
		return undefined;
	}
	return boundaries.reduce((earliest, boundary) => (boundary.index < earliest.index ? boundary : earliest));
}

function parseSseBlock(rawEvent: string): ParsedSseEvent | undefined {
	const dataLines: string[] = [];
	for (const line of rawEvent.split(/\r\n|\r|\n/)) {
		if (line === "" || line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("data:")) {
			const data = line.slice(5);
			dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
		}
	}
	if (dataLines.length === 0) {
		return undefined;
	}
	return { data: dataLines.join("\n") };
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text.trim() === "") {
		return undefined;
	}
	return JSON.parse(text) as unknown;
}

async function readJsonOrUndefined(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type");
	if (contentType?.includes("application/json") !== true) {
		return undefined;
	}
	return readJson(response);
}

function parseServiceEvent(data: string): DPiServiceEvent {
	const value = JSON.parse(data) as unknown;
	if (isServiceEvent(value)) {
		return value;
	}
	throw new DPiRemoteClientError("invalid_event", "Remote service returned an invalid event", 200);
}

function isServiceEvent(value: unknown): value is DPiServiceEvent {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	if (value.type === "snapshot") {
		return isDPiServiceSnapshot(value.snapshot);
	}
	if ((value.type === "runtime" || value.type === "worker") && typeof value.event === "string") {
		return value.data === undefined || isDPiJsonValue(value.data);
	}
	return false;
}

function throwIfServiceError(value: unknown, status: number): asserts value is Exclude<unknown, DPiServiceError> {
	if (!isDPiServiceError(value)) {
		return;
	}
	throw new DPiRemoteClientError(value.error.code, value.error.message, status, value.error.details);
}
