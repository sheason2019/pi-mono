import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionProxy } from "../../core/agent-session-proxy.ts";
import { handleApiRequest } from "./api-handlers.ts";

interface SseConnection {
	res: ServerResponse;
	heartbeatTimer: ReturnType<typeof setInterval>;
}

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

			// REST API
			await handleApiRequest(this._proxy, req, res);
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

	private handleSseConnection(_req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("\n");

		// Send SSE heartbeat every 30s to keep the connection alive
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
