export type RemoteCallEvent = {
	callId: string;
	tool: string;
	params: unknown;
};

export type CancelCallEvent = {
	callId: string;
};

export type ResultPayload =
	| { connectId: string; callId: string; ok: true; result: unknown }
	| { connectId: string; callId: string; ok: false; error: string };

export type ResultInput = { callId: string; ok: true; result: unknown } | { callId: string; ok: false; error: string };

export interface ExecutorClientOptions {
	hubUrl: string;
	/** Bearer token. Omit in dev mode (hub without auth). */
	authToken?: string;
	connectId: string;
	onCommand: (event: RemoteCallEvent) => Promise<void> | void;
	onCancel?: (event: CancelCallEvent) => void;
}

/** Small helper: do a fetch with the executor's auth header (omitted
 *  when no token, e.g. in dev mode). */
async function hubFetch(
	hubUrl: string,
	authToken: string | undefined,
	href: string,
	init: { method: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
	const url = new URL(href, hubUrl);
	const headers: Record<string, string> = { ...init.headers };
	if (authToken) headers.Authorization = `Bearer ${authToken}`;
	if (init.body && !headers["Content-Type"]) {
		headers["Content-Type"] = "application/json";
	}
	return fetch(url, {
		method: init.method,
		headers,
		body: init.body,
		signal: init.signal,
	});
}

/** Parse SSE events from a Web ReadableStream reader. Resolves when
 *  the stream closes or an error occurs. Calls `close` on end/error. */
async function readSseEvents(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	onRemoteCall: (event: RemoteCallEvent) => Promise<void> | void,
	onCancelCall: ((event: CancelCallEvent) => void) | undefined,
	close: () => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			// Pull complete SSE events off the buffer one at a time. We
			// re-scan the buffer on every iteration (not just on success) so
			// a comment-only frame like ": ok\n\n" can't get stuck re-testing
			// the original condition and wedge the loop.
			while (true) {
				const idx = buf.indexOf("\n\n");
				if (idx === -1) break;
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let eventName = "message";
				const dataLines: string[] = [];
				for (const line of raw.split("\n")) {
					if (line.startsWith("event: ")) eventName = line.slice(7).trim();
					else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
				}
				if (dataLines.length === 0) continue;
				const dataStr = dataLines.join("\n");
				if (eventName === "remote-call") {
					try {
						const event = JSON.parse(dataStr) as RemoteCallEvent;
						// onRemoteCall may be sync or async; normalize to a promise so
						// any throw from sendResult is caught and logged rather than
						// crashing the executor process.
						Promise.resolve(onRemoteCall(event)).catch((e: unknown) => {
							const msg = e instanceof Error ? e.message : String(e);
							process.stderr.write(`[executor] command failed: ${msg}\n`);
						});
					} catch {
						/* ignore malformed */
					}
				} else if (eventName === "cancel-call") {
					if (onCancelCall) {
						try {
							const event = JSON.parse(dataStr) as CancelCallEvent;
							onCancelCall(event);
						} catch {
							/* ignore malformed */
						}
					}
				}
				// "connected" is informational; no-op.
			}
		}
	} catch {
		/* stream error or abort; handled in finally */
	} finally {
		close();
	}
}

/** Executor-side client. Registers with the hub, opens SSE, forwards
 *  remote-call events to `onCommand`, and POSTs results back. */
export class ExecutorClient {
	private readonly opts: ExecutorClientOptions;
	private controller: AbortController | null = null;
	constructor(opts: ExecutorClientOptions) {
		this.opts = opts;
	}

	async start(): Promise<void> {
		// 1) Register.
		const regRes = await hubFetch(this.opts.hubUrl, this.opts.authToken, "/api/executor/register", {
			method: "POST",
			body: JSON.stringify({ connectId: this.opts.connectId, cwd: process.cwd() }),
		});
		if (!regRes.ok) {
			throw new Error(`Failed to register executor: ${regRes.status} ${await regRes.text()}`);
		}

		// 2) Open SSE via fetch + ReadableStream.
		const controller = new AbortController();
		this.controller = controller;
		const sseUrl = new URL(
			`/api/executor/events?connectId=${encodeURIComponent(this.opts.connectId)}`,
			this.opts.hubUrl,
		);
		const headers: Record<string, string> = { Accept: "text/event-stream" };
		if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`;

		const res = await fetch(sseUrl, { headers, signal: controller.signal });
		if (!res.ok) {
			throw new Error(`SSE subscribe failed: ${res.status}`);
		}
		if (!res.body) {
			throw new Error("SSE subscribe failed: no response body");
		}

		const reader = res.body.getReader();
		void readSseEvents(reader, this.opts.onCommand, this.opts.onCancel, () => {
			// SSE ended: the hub disconnected us (graceful shutdown or
			// server died) or the underlying socket errored out. We
			// deliberately do not reconnect. The executor's lifetime
			// is bound to the d-pi connect parent; if the hub comes
			// back the user re-runs d-pi connect, which spawns a
			// fresh executor. Reconnecting here would also hold the
			// SSE I/O open long enough to defeat SIGTERM, which is
			// what caused the connect process to hang on server exit.
			process.stderr.write("[executor] SSE ended, exiting\n");
			process.exit(0);
		});
	}

	async sendResult(payload: ResultInput): Promise<void> {
		const res = await hubFetch(this.opts.hubUrl, this.opts.authToken, "/api/executor/results", {
			method: "POST",
			body: JSON.stringify({ connectId: this.opts.connectId, ...payload }),
		});
		if (!res.ok) {
			throw new Error(`Failed to post result: ${res.status} ${await res.text()}`);
		}
	}

	stop(): void {
		if (this.controller) {
			try {
				this.controller.abort();
			} catch {
				/* ignore */
			}
			this.controller = null;
		}
	}
}
