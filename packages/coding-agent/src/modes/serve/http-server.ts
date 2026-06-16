import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionProxy } from "../../core/agent-session-proxy.ts";
import { handleProtocolQuery, handleProtocolRequest } from "./protocol-core.ts";

interface SseConnection {
	res: ServerResponse;
	heartbeatTimer: ReturnType<typeof setInterval>;
}

/**
 * HTTP wrapper around the protocol-core.
 *
 * This is the HTTP transport adapter for `pi serve` standalone mode.
 * It translates HTTP requests into protocol-core calls:
 *
 * - GET /state, /messages, /tree, ... → handleProtocolQuery
 * - POST /prompt, /abort, /set-model, ... → handleProtocolRequest
 * - GET /events → SSE (subscribe to proxy events, broadcast to connections)
 *
 * The same protocol-core functions are used by AgentIpcServer (the
 * stdio/IPC transport in d-pi hub mode), so both transports share
 * identical handler logic.
 */
export class AgentHttpServer {
	private readonly _connections: Set<SseConnection> = new Set();
	private _server: Server | undefined;
	private _unsubscribe: (() => void) | undefined;
	private readonly _proxy: AgentSessionProxy;

	constructor(proxy: AgentSessionProxy) {
		this._proxy = proxy;
	}

	async start(port: number): Promise<void> {
		this._server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const path = url.pathname;

			// SSE endpoint
			if (path === "/events" && req.method === "GET") {
				this.handleSseConnection(req, res);
				return;
			}

			// Route to protocol-core
			await this.handleHttpRequest(req, res, path);
		});

		// Subscribe to proxy events and forward to all SSE connections
		this._unsubscribe = this._proxy.subscribe((event: AgentSessionEvent) => {
			this.broadcastEvent(event);
		});

		return new Promise((resolve, reject) => {
			this._server!.listen(port, () => resolve());
			this._server!.on("error", reject);
		});
	}

	/**
	 * Translate an HTTP request into a protocol-core call.
	 *
	 * GET → handleProtocolQuery (read-only data queries)
	 * POST → handleProtocolRequest (action operations)
	 */
	private async handleHttpRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
		const method = req.method ?? "GET";
		// Strip leading "/" to get the query/action name
		const name = path.startsWith("/") ? path.slice(1) : path;

		if (method === "GET") {
			const result = await handleProtocolQuery(this._proxy, name);
			this.writeJson(res, result.status, result.body);
			return;
		}

		if (method === "POST") {
			const body = await this.readBody(req);
			const result = await handleProtocolRequest(this._proxy, name, body);
			this.writeJson(res, result.status, result.body);
			return;
		}

		this.writeJson(res, 405, { error: `Method not allowed: ${method}` });
	}

	private writeJson(res: ServerResponse, statusCode: number, data: unknown): void {
		const body = JSON.stringify(data);
		res.writeHead(statusCode, {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	}

	private readBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				if (!raw) {
					resolve(undefined);
					return;
				}
				try {
					resolve(JSON.parse(raw));
				} catch {
					reject(new Error("Invalid JSON body"));
				}
			});
			req.on("error", reject);
		});
	}

	private handleSseConnection(_req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("\n");

		const heartbeatTimer = setInterval(() => {
			try {
				res.write(": heartbeat\n\n");
			} catch {
				clearInterval(heartbeatTimer);
			}
		}, 30_000);

		const connection: SseConnection = { res, heartbeatTimer };
		this._connections.add(connection);

		res.on("close", () => {
			clearInterval(heartbeatTimer);
			this._connections.delete(connection);
		});
	}

	private broadcastEvent(event: AgentSessionEvent): void {
		const data = JSON.stringify(event);
		const message = `data: ${data}\n\n`;
		for (const connection of this._connections) {
			try {
				connection.res.write(message);
			} catch {
				this._connections.delete(connection);
			}
		}
	}

	async stop(): Promise<void> {
		this._unsubscribe?.();
		this._unsubscribe = undefined;

		for (const connection of this._connections) {
			try {
				connection.res.end();
			} catch {
				// Ignore errors on already-closed connections
			}
		}
		this._connections.clear();

		if (this._server) {
			return new Promise((resolve, reject) => {
				this._server!.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		}
	}

	get connectionCount(): number {
		return this._connections.size;
	}
}
