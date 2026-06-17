import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionProxy } from "../../core/agent-session-proxy.ts";
import { handleProtocolQuery, handleProtocolRequest } from "./protocol-core.ts";

export interface IpcTransport {
	postMessage(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
}

export interface IpcMessageHandlers {
	onHttpResponse(requestId: string, status: number, body: unknown): void;
	onSseEvent(subscriberId: string, event: string, data: unknown): void;
}

/**
 * IPC server for agent serve mode — the stdio/core transport.
 *
 * Replaces AgentHttpServer when running inside a d-pi worker thread.
 * Instead of binding an HTTP port, it listens for IPC messages from
 * the hub (via parentPort) and responds via IPC messages back.
 *
 * The hub gateway acts as the HTTP-to-IPC bridge: external HTTP
 * requests are translated into IPC messages, sent here, and the
 * responses are translated back to HTTP.
 *
 * SSE is handled by the gateway directly — when a client connects
 * to GET /agents/{name}/events, the gateway sends an sse_subscribe
 * message. This server subscribes to the proxy's event stream and
 * forwards events back as sse_event messages. The gateway then
 * writes them as SSE to the client's HTTP connection.
 */
export class AgentIpcServer {
	private readonly _proxy: AgentSessionProxy;
	private readonly _transport: IpcTransport;
	private readonly _handlers: IpcMessageHandlers;
	private _unsubscribe: (() => void) | undefined;
	private readonly _subscribers = new Set<string>();

	constructor(proxy: AgentSessionProxy, transport: IpcTransport, handlers: IpcMessageHandlers) {
		this._proxy = proxy;
		this._transport = transport;
		this._handlers = handlers;
	}

	start(): void {
		// Listen for IPC messages from the hub
		this._transport.onMessage((message) => {
			this._handleMessage(message).catch((e: unknown) => {
				process.stderr.write(
					`[d-pi ipc-server] Error handling message: ${e instanceof Error ? e.message : String(e)}\n`,
				);
			});
		});

		// Subscribe to proxy events and broadcast to all SSE subscribers
		this._unsubscribe = this._proxy.subscribe((event: AgentSessionEvent) => {
			this._broadcastSseEvent(event);
		});
	}

	private async _handleMessage(message: unknown): Promise<void> {
		const msg = message as { type?: string; [key: string]: unknown };

		switch (msg.type) {
			case "http_request": {
				const { requestId, action, data } = msg as {
					requestId: string;
					action: string;
					data: unknown;
				};
				const result = await handleProtocolRequest(this._proxy, action, data);
				this._handlers.onHttpResponse(requestId, result.status, result.body);
				break;
			}

			case "http_query": {
				const { requestId, query } = msg as { requestId: string; query: string };
				const result = await handleProtocolQuery(this._proxy, query);
				this._handlers.onHttpResponse(requestId, result.status, result.body);
				break;
			}

			case "sse_subscribe": {
				const { subscriberId } = msg as { subscriberId: string };
				this._subscribers.add(subscriberId);
				break;
			}

			case "sse_unsubscribe": {
				const { subscriberId } = msg as { subscriberId: string };
				this._subscribers.delete(subscriberId);
				break;
			}
		}
	}

	private _broadcastSseEvent(event: AgentSessionEvent): void {
		for (const subscriberId of this._subscribers) {
			this._handlers.onSseEvent(subscriberId, event.type, event);
		}
	}

	stop(): void {
		this._unsubscribe?.();
		this._unsubscribe = undefined;
		this._subscribers.clear();
	}
}
