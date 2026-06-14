import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";

export type RemoteCallEvent = {
	callId: string;
	tool: string;
	params: unknown;
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
}

/** Small helper: do a fetch with the executor's auth header (omitted
 *  when no token, e.g. in dev mode). */
async function hubFetch(
	hubUrl: string,
	authToken: string | undefined,
	href: string,
	init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<Response> {
	const url = new URL(href, hubUrl);
	const headers: Record<string, string> = { ...init.headers };
	if (authToken) headers.Authorization = `Bearer ${authToken}`;
	if (init.body && !headers["Content-Type"]) {
		headers["Content-Type"] = "application/json";
	}
	// Use node:http so we get streaming for SSE.
	if (init.method === "GET") {
		return new Promise<Response>((resolve, reject) => {
			const req = httpRequest(
				{
					hostname: url.hostname,
					port: url.port,
					path: url.pathname + url.search,
					method: "GET",
					headers: { Accept: "text/event-stream", ...headers },
				},
				(res) => resolve(res as unknown as Response),
			);
			req.on("error", reject);
			req.end();
		});
	}
	return fetch(url, {
		method: init.method,
		headers,
		body: init.body,
	});
}

function readSseEvents(
	stream: NodeJS.ReadableStream | null,
	onRemoteCall: (event: RemoteCallEvent) => Promise<void> | void,
	close: () => void,
): void {
	if (!stream) return;
	let buf = "";
	const onData = (chunk: Buffer | string) => {
		buf += chunk.toString();
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
			}
			// "connected" is informational; no-op.
		}
	};
	const onEnd = () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("error", onError);
		close();
	};
	const onError = () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("error", onError);
		close();
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	stream.on("error", onError);
}

/** Executor-side client. Registers with the hub, opens SSE, forwards
 *  remote-call events to `onCommand`, and POSTs results back. */
export class ExecutorClient {
	private readonly opts: ExecutorClientOptions;
	private req: ClientRequest | null = null;
	constructor(opts: ExecutorClientOptions) {
		this.opts = opts;
	}

	async start(): Promise<void> {
		// 1) Register.
		const regRes = await hubFetch(this.opts.hubUrl, this.opts.authToken, "/_hub/executor/register", {
			method: "POST",
			body: JSON.stringify({ connectId: this.opts.connectId, cwd: process.cwd() }),
		});
		if (!regRes.ok) {
			throw new Error(`Failed to register executor: ${regRes.status} ${await regRes.text()}`);
		}

		// 2) Open SSE via raw http so we get a streaming body.
		await new Promise<void>((resolve, reject) => {
			const u = new URL(
				`/_hub/executor/events?connectId=${encodeURIComponent(this.opts.connectId)}`,
				this.opts.hubUrl,
			);
			const req = httpRequest(
				{
					hostname: u.hostname,
					port: u.port,
					path: u.pathname + u.search,
					method: "GET",
					headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.opts.authToken}` },
				},
				(res: IncomingMessage) => {
					if (res.statusCode !== 200) {
						reject(new Error(`SSE subscribe failed: ${res.statusCode}`));
						return;
					}
					this.req = req;
					readSseEvents(res, this.opts.onCommand, () => {
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
					resolve();
				},
			);
			req.on("error", reject);
			req.end();
		});
	}

	async sendResult(payload: ResultInput): Promise<void> {
		const res = await hubFetch(this.opts.hubUrl, this.opts.authToken, "/_hub/executor/results", {
			method: "POST",
			body: JSON.stringify({ connectId: this.opts.connectId, ...payload }),
		});
		if (!res.ok) {
			throw new Error(`Failed to post result: ${res.status} ${await res.text()}`);
		}
	}

	stop(): void {
		if (this.req) {
			try {
				this.req.destroy();
			} catch {
				/* ignore */
			}
			this.req = null;
		}
	}
}
