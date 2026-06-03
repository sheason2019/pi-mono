import { request as httpRequest, type IncomingMessage } from "node:http";

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
	authToken: string;
	connectId: string;
	onCommand: (event: RemoteCallEvent) => void;
}

/** Small helper: do a fetch with the executor's auth header. */
async function hubFetch(
	hubUrl: string,
	authToken: string,
	href: string,
	init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<Response> {
	const url = new URL(href, hubUrl);
	const headers: Record<string, string> = {
		Authorization: "Bearer " + authToken,
		...init.headers,
	};
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
	connectId: string,
	onRemoteCall: (event: RemoteCallEvent) => void,
	close: () => void,
): void {
	if (!stream) return;
	let buf = "";
	const onData = (chunk: Buffer | string) => {
		buf += chunk.toString();
		const idx = buf.indexOf("\n\n");
		while (idx !== -1) {
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
					onRemoteCall(event);
				} catch {
					/* ignore malformed */
				}
			}
			// "connected" is informational; no-op.
			void connectId;
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
	private req: import("node:http").ClientRequest | null = null;
	private stopped = false;

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
			throw new Error("Failed to register executor: " + regRes.status + " " + (await regRes.text()));
		}

		// 2) Open SSE via raw http so we get a streaming body.
		await new Promise<void>((resolve, reject) => {
			const u = new URL(
				"/_hub/executor/events?connectId=" + encodeURIComponent(this.opts.connectId),
				this.opts.hubUrl,
			);
			const req = httpRequest(
				{
					hostname: u.hostname,
					port: u.port,
					path: u.pathname + u.search,
					method: "GET",
					headers: { Accept: "text/event-stream", Authorization: "Bearer " + this.opts.authToken },
				},
				(res: IncomingMessage) => {
					if (res.statusCode !== 200) {
						reject(new Error("SSE subscribe failed: " + res.statusCode));
						return;
					}
					this.req = req;
					readSseEvents(res, this.opts.connectId, this.opts.onCommand, () => {
						if (!this.stopped) this.start().catch(() => {});
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
			throw new Error("Failed to post result: " + res.status + " " + (await res.text()));
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.req) {
			this.req.destroy();
			this.req = null;
		}
	}
}
