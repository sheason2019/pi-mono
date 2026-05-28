import type { AgentSessionEvent } from "../../core/agent-session.ts";

export class SseClient {
	private _abortController: AbortController | undefined;
	private _connected = false;
	private readonly _url: string;
	private readonly _onEvent: (event: AgentSessionEvent) => void;
	private readonly _onError: (error: Error) => void;
	private readonly _onClose: () => void;

	constructor(
		url: string,
		onEvent: (event: AgentSessionEvent) => void,
		onError: (error: Error) => void,
		onClose: () => void,
	) {
		this._url = url;
		this._onEvent = onEvent;
		this._onError = onError;
		this._onClose = onClose;
	}

	async connect(): Promise<void> {
		this._abortController = new AbortController();

		const response = await fetch(this._url, {
			method: "GET",
			headers: { Accept: "text/event-stream" },
			signal: this._abortController.signal,
		});

		if (!response.ok) {
			throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error("SSE connection: no response body");
		}

		this._connected = true;
		this.readStream(response.body);
	}

	private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE messages from buffer
				const parts = buffer.split("\n\n");
				// Keep the last incomplete part in the buffer
				buffer = parts.pop() ?? "";

				for (const part of parts) {
					const event = this.parseSseMessage(part);
					if (event) {
						this._onEvent(event);
					}
				}
			}
		} catch (e: unknown) {
			if (e instanceof Error && e.name === "AbortError") {
				// Normal disconnect
			} else {
				this._onError(e instanceof Error ? e : new Error(String(e)));
			}
		} finally {
			this._connected = false;
			this._onClose();
		}
	}

	private parseSseMessage(message: string): AgentSessionEvent | undefined {
		for (const line of message.split("\n")) {
			if (line.startsWith("data: ")) {
				const json = line.slice(6);
				try {
					return JSON.parse(json) as AgentSessionEvent;
				} catch {
					return undefined;
				}
			}
		}
		return undefined;
	}

	disconnect(): void {
		this._abortController?.abort();
		this._abortController = undefined;
		this._connected = false;
	}

	get connected(): boolean {
		return this._connected;
	}
}
