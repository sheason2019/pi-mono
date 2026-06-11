import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthSessionInfo, AuthSessionManager } from "../auth/auth-session.ts";
import { injectMeta } from "../extension/message-meta.ts";
import type { SourceConfig } from "../types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { ExecutorRegistry } from "./executor-registry.ts";
import type { SourceManager } from "./source-manager.ts";

/**
 * HTTP gateway for the d-pi Hub.
 *
 * Routes:
 *   /_hub/agents       GET  → list all agents
 *   /_hub/agents       POST → create agent
 *   /_hub/agents/{id}  DELETE → destroy agent
 *   /_hub/group-architecture  GET  → group architecture snapshot
 *   /_hub/sources      GET  → list all sources
 *   /_hub/sources      POST → create source
 *   /_hub/sources/{name} DELETE → destroy source
 *   /agents/{id}/*     → reverse proxy to agent's HTTP server
 *   /*                 → reverse proxy to root agent
 */
export interface HubGatewayOptions {
	/** Max time to wait for an executor to POST a result to
	 *  /_hub/executor/results before failing the pending
	 *  /agents/{id}/remote-call. Default 60_000. */
	remoteCallTimeoutMs?: number;
}

export class HubGateway {
	private _server: Server | undefined;
	private readonly _registry: AgentRegistry;
	private readonly _sourceManager: SourceManager;
	private readonly _onCreateAgent: (
		parentAgentId: string | undefined,
		options: { name: string; cwd?: string; model?: string; roles?: string[] },
	) => Promise<{ agentId: string; name: string }>;
	private readonly _onDestroyAgent: (agentId: string) => Promise<void>;
	private readonly _auth: AuthSessionManager | undefined;
	private readonly _executorRegistry: ExecutorRegistry | undefined;
	private readonly _agentBindings: Map<string, string> = new Map();
	private readonly _remoteCallTimeoutMs: number;

	constructor(
		registry: AgentRegistry,
		sourceManager: SourceManager,
		onCreateAgent: HubGateway["_onCreateAgent"],
		onDestroyAgent: HubGateway["_onDestroyAgent"],
		auth?: AuthSessionManager,
		executorRegistry?: ExecutorRegistry,
		options?: HubGatewayOptions,
	) {
		this._registry = registry;
		this._sourceManager = sourceManager;
		this._onCreateAgent = onCreateAgent;
		this._onDestroyAgent = onDestroyAgent;
		this._auth = auth;
		this._executorRegistry = executorRegistry;
		this._remoteCallTimeoutMs = options?.remoteCallTimeoutMs ?? 60_000;
	}

	async start(port: number): Promise<void> {
		this._server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const path = url.pathname;

			try {
				// Hub internal API
				if (path.startsWith("/_hub/")) {
					await this._handleHubApi(req, res, path);
					return;
				}

				// /agents/{id}/remote-call — dispatch to the bound executor and block
				// until the executor POSTs the result back. Must be checked BEFORE the
				// generic /agents/{id}/* proxy below. Auth is required: without it,
				// anyone reachable on the hub port could invoke remote tools on a
				// connected user's machine (RCE via the executor).
				const remoteCallMatch = path.match(/^\/agents\/([^/]+)\/remote-call$/);
				if (remoteCallMatch && req.method === "POST") {
					if (!this._authenticate(req)) {
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Unauthorized" }));
						return;
					}
					const agentId = remoteCallMatch[1]!;
					const connectId = this._agentBindings.get(agentId);
					if (!connectId) {
						res.writeHead(409, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Agent not in connect mode" }));
						return;
					}
					const execReg = this._executorRegistry;
					if (!execReg) {
						res.writeHead(409, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Executor registry not configured" }));
						return;
					}
					const handle = execReg.get(connectId);
					if (!handle) {
						res.writeHead(409, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Executor not available" }));
						return;
					}
					try {
						const body = await this._readBody(req);
						const { callId, tool, params } = JSON.parse(body) as {
							callId?: string;
							tool?: string;
							params?: unknown;
						};
						if (!callId || !tool) {
							throw new Error("callId and tool are required");
						}
						// I2: fail fast if the executor is pre-registered but has
						// not yet attached its SSE channel. Without this, the
						// call would be parked in pendingCalls and only resolve
						// on the (never arriving) result POST.
						if (!handle.sseConn) {
							res.writeHead(409, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: "Executor not yet ready" }));
							return;
						}
						execReg.addPending(connectId, callId, res);
						// I1: server-side timeout. If the executor never POSTs a
						// result (tool hangs, SSE message lost, half-open TCP), fail
						// the pending call so the agent's tool.execute does not hang.
						const timeoutMs = this._remoteCallTimeoutMs;
						const timer = setTimeout(() => {
							const pending = execReg.getPending(connectId, callId);
							if (pending) {
								execReg.clearPendingTimer(connectId, callId);
								execReg.removePending(connectId, callId);
								try {
									pending.writeHead(504, { "Content-Type": "application/json" });
									pending.end(JSON.stringify({ ok: false, error: "Remote call timed out" }));
								} catch {
									/* ignore */
								}
								process.stderr.write(`[hub] remote call ${callId} timed out after ${timeoutMs}ms\n`);
							}
						}, timeoutMs);
						execReg.setPendingTimer(connectId, callId, timer);
						handle.sseConn.send("remote-call", { callId, tool, params });
						// `res` is now held; the executor's result POST (or the
						// timeout above) will resolve it.
						return;
					} catch (err) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
						return;
					}
				}

				// Agent routing: /agents/{id}/* → specific agent
				const agentMatch = path.match(/^\/agents\/([^/]+)(\/.*)?$/);
				if (agentMatch) {
					const agentId = agentMatch[1];
					const agentPath = agentMatch[2] ?? "/";
					await this._proxyToAgent(req, res, agentId, agentPath);
					return;
				}

				// Default: /* → root agent
				const rootAgent = this._registry.getRootAgent();
				if (rootAgent) {
					await this._proxyToAgent(req, res, rootAgent.id, path);
					return;
				}

				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "No root agent available" }));
			} catch (err) {
				process.stderr.write(`[d-pi gateway] Error: ${err}\n`);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			}
		});

		return new Promise((resolve, reject) => {
			this._server!.listen(port, () => resolve());
			this._server!.on("error", reject);
		});
	}

	/** Bind an agentId to a connectId so remote tool calls can be dispatched. */
	bindAgent(agentId: string, connectId: string): void {
		this._agentBindings.set(agentId, connectId);
	}

	/** Remove the binding. */
	unbindAgent(agentId: string): void {
		this._agentBindings.delete(agentId);
	}

	/** Number of agent->connectId bindings currently held. Exposed for
	 *  tests and operational introspection; the map itself stays private. */
	get bindingCount(): number {
		return this._agentBindings.size;
	}

	/** Resolve a single binding. Exposed for tests. */
	getBinding(agentId: string): string | undefined {
		return this._agentBindings.get(agentId);
	}

	/**
	 * Drop every binding that points at the given connectId. Called when
	 * the executor's SSE channel closes so a stale binding cannot dispatch
	 * to a now-disconnected executor.
	 */
	unbindByConnectId(connectId: string): number {
		let removed = 0;
		for (const [agentId, cid] of this._agentBindings) {
			if (cid === connectId) {
				this._agentBindings.delete(agentId);
				removed++;
			}
		}
		return removed;
	}

	async stop(): Promise<void> {
		if (this._server) {
			return new Promise((resolve, reject) => {
				this._server!.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		}
	}

	url(): string {
		if (!this._server) {
			throw new Error("Gateway is not running");
		}
		const address = this._server.address() as AddressInfo | null;
		if (!address) {
			throw new Error("Gateway address is unavailable");
		}
		return `http://127.0.0.1:${address.port}`;
	}

	private _authenticate(req: IncomingMessage): AuthSessionInfo | undefined {
		if (!this._auth) return { publicKey: "", auth: { name: "local", description: "local" } };
		const header = req.headers.authorization;
		if (!header?.startsWith("Bearer ")) return undefined;
		return this._auth.verifyToken(header.slice("Bearer ".length));
	}

	private async _handleHubApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
		if (path === "/_hub/auth/challenge" && req.method === "POST") {
			if (!this._auth) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Auth is not enabled" }));
				return;
			}
			// Compute the result BEFORE writing response headers. Otherwise a
			// throw from createChallenge() (e.g. "Public key is not allowed")
			// would send a 200 with no body (writeHead already flushed) and
			// the catch's 401 would hit ERR_HTTP_HEADERS_SENT, leaving the
			// client hung waiting for a body that never arrives. By computing
			// first, any throw cleanly produces a real 4xx.
			let challenge: { challengeId: string; challenge: string };
			try {
				const body = await this._readBody(req);
				const params = JSON.parse(body) as { publicKey?: string };
				if (!params.publicKey) throw new Error("publicKey is required");
				challenge = this._auth.createChallenge(params.publicKey);
			} catch (err) {
				if (!res.headersSent) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
				} else {
					// Defensive: if some prior code path already flushed headers
					// (e.g. a buggy proxy or write), tear down the socket so the
					// client does not hang on a half-closed response.
					res.destroy();
				}
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(challenge));
			return;
		}

		if (path === "/_hub/auth/session" && req.method === "POST") {
			if (!this._auth) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Auth is not enabled" }));
				return;
			}
			// Same ordering rationale as /_hub/auth/challenge: compute first,
			// write the response after, so a throw from createSession() cannot
			// leave the response in a half-closed 200 state.
			let session: { token: string; auth: { name: string; description: string } };
			try {
				const body = await this._readBody(req);
				const params = JSON.parse(body) as {
					publicKey?: string;
					challengeId?: string;
					signature?: string;
				};
				if (!params.publicKey || !params.challengeId || !params.signature) {
					throw new Error("publicKey, challengeId, and signature are required");
				}
				session = this._auth.createSession({
					publicKey: params.publicKey,
					challengeId: params.challengeId,
					signature: params.signature,
				});
			} catch (err) {
				if (!res.headersSent) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
				} else {
					res.destroy();
				}
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(session));
			return;
		}

		const auth = this._authenticate(req);
		if (!auth) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		// GET /_hub/agents — list all agents
		if (path === "/_hub/agents" && req.method === "GET") {
			const snapshot = this._registry.getGroupArchitectureSnapshot();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(snapshot.agents));
			return;
		}

		// POST /_hub/agents — create agent
		if (path === "/_hub/agents" && req.method === "POST") {
			const body = await this._readBody(req);
			const params = JSON.parse(body) as {
				parentAgentId?: string;
				name: string;
				cwd?: string;
				model?: string;
				roles?: string[];
			};
			try {
				const result = await this._onCreateAgent(params.parentAgentId, {
					name: params.name,
					cwd: params.cwd,
					model: params.model,
					roles: params.roles,
				});
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// DELETE /_hub/agents/{id} — destroy agent
		const deleteMatch = path.match(/^\/_hub\/agents\/([^/]+)$/);
		if (deleteMatch && req.method === "DELETE") {
			const agentId = deleteMatch[1];
			try {
				await this._onDestroyAgent(agentId);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// POST /_hub/agents/{id}/bind — bind an agent id to a connect id so the
		// hub can dispatch /agents/{id}/remote-call requests to the executor
		// registered for that connect id. Called by `d-pi connect` after the
		// auth handshake.
		const bindMatch = path.match(/^\/_hub\/agents\/([^/]+)\/bind$/);
		if (bindMatch && req.method === "POST") {
			try {
				const body = await this._readBody(req);
				const { connectId } = JSON.parse(body) as { connectId?: string };
				if (!connectId) throw new Error("connectId is required");
				this.bindAgent(bindMatch[1]!, connectId);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// POST /_hub/agents/{id}/unbind — drop the agent→connectId binding.
		// Called by `d-pi connect` on session exit.
		const unbindMatch = path.match(/^\/_hub\/agents\/([^/]+)\/unbind$/);
		if (unbindMatch && req.method === "POST") {
			this.unbindAgent(unbindMatch[1]!);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		// GET /_hub/group-architecture — group architecture snapshot
		if (path === "/_hub/group-architecture" && req.method === "GET") {
			const snapshot = this._registry.getGroupArchitectureSnapshot();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(snapshot));
			return;
		}

		// GET /_hub/sources — list all sources
		if (path === "/_hub/sources" && req.method === "GET") {
			const sources = this._sourceManager.listSources();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(sources));
			return;
		}

		// POST /_hub/sources — create source
		if (path === "/_hub/sources" && req.method === "POST") {
			const body = await this._readBody(req);
			const params = JSON.parse(body) as SourceConfig;
			try {
				this._sourceManager.createSource(params);
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// DELETE /_hub/sources/{name} — destroy source
		const sourceDeleteMatch = path.match(/^\/_hub\/sources\/([^/]+)$/);
		if (sourceDeleteMatch && req.method === "DELETE") {
			const sourceName = decodeURIComponent(sourceDeleteMatch[1]);
			try {
				this._sourceManager.destroySource(sourceName);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		if (path === "/_hub/executor/events" && req.method === "GET") {
			const execReg = this._executorRegistry;
			if (!execReg) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Executor registry not configured" }));
				return;
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const connectId = url.searchParams.get("connectId");
			if (!connectId) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "connectId is required" }));
				return;
			}
			const handle = execReg.get(connectId);
			if (!handle) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Not registered" }));
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.flushHeaders();
			res.write(`event: connected\ndata: ${JSON.stringify({ connectId })}\n\n`);
			const sseConn = {
				send: (event: string, data: unknown) => {
					try {
						res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
					} catch {
						/* broken pipe */
					}
				},
			};
			const cid = connectId;
			execReg.attachSse(cid, sseConn);
			// M3: keepalive. Without periodic bytes, intermediate proxies
			// (and many corporate NATs) will silently drop an idle SSE
			// connection after ~60s. A comment line is a no-op for the
			// EventSource parser but counts as activity.
			const keepalive = setInterval(() => {
				try {
					res.write(": keepalive\n\n");
				} catch {
					/* broken pipe; the close handler will run */
				}
			}, 30_000);
			req.on("close", () => {
				clearInterval(keepalive);
				// M4: GC the agent->connectId bindings pointing at this
				// executor so future /remote-call requests do not try to
				// dispatch to a dead SSE channel.
				this.unbindByConnectId(cid);
				execReg.deregister(cid);
			});
			return;
		}

		if (path === "/_hub/executor/results" && req.method === "POST") {
			const execReg = this._executorRegistry;
			if (!execReg) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Executor registry not configured" }));
				return;
			}
			try {
				const body = await this._readBody(req);
				const { connectId, callId, ok, result, error } = JSON.parse(body) as {
					connectId?: string;
					callId?: string;
					ok?: boolean;
					result?: unknown;
					error?: string;
				};
				if (!connectId || !callId || typeof ok !== "boolean") {
					throw new Error("connectId, callId, and ok are required");
				}
				const pending = execReg.getPending(connectId, callId);
				if (pending) {
					pending.writeHead(200, { "Content-Type": "application/json" });
					pending.end(JSON.stringify(ok ? { ok: true, result } : { ok: false, error }));
					execReg.clearPendingTimer(connectId, callId);
					execReg.removePending(connectId, callId);
				} else {
					process.stderr.write(`[hub] dropping result for unknown callId ${callId}\n`);
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		if (path === "/_hub/executor/register" && req.method === "POST") {
			if (!this._executorRegistry) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Executor registry not configured" }));
				return;
			}
			try {
				const body = await this._readBody(req);
				const { connectId, cwd } = JSON.parse(body) as { connectId?: string; cwd?: string };
				if (!connectId || !cwd) {
					throw new Error("connectId and cwd are required");
				}
				this._executorRegistry.preRegister(connectId, { cwd });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const status = /already registered/i.test(msg) ? 409 : 400;
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: msg }));
			}
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	}

	private async _proxyToAgent(
		req: IncomingMessage,
		res: ServerResponse,
		agentId: string,
		path: string,
	): Promise<void> {
		const agent = this._registry.get(agentId);
		if (!agent) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Agent not found: ${agentId}` }));
			return;
		}
		const auth = this._authenticate(req);
		if (!auth) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		const targetUrl = `http://localhost:${agent.port}${path}`;
		const url = new URL(req.url ?? "/", "http://localhost");

		// Block session management POST endpoints in d-pi connect mode
		const blockedSessionEndpoints = new Set(["new-session", "switch-session", "fork"]);
		if (req.method === "POST" && blockedSessionEndpoints.has(path)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Session operations are managed by the d-pi hub" }));
			return;
		}

		// Intercept POST /prompt to inject message meta header
		const isPromptRequest = req.method === "POST" && path === "/prompt";

		if (isPromptRequest) {
			// Read body, inject meta, then forward
			try {
				const body = await this._readBody(req);
				const parsed = JSON.parse(body) as { text?: string; options?: unknown };
				if (parsed.text) {
					parsed.text = injectMeta(parsed.text, "connect", auth.auth);
				}
				const rewrittenBody = JSON.stringify(parsed);

				const proxyReq = request(
					targetUrl,
					{
						method: "POST",
						headers: {
							...req.headers,
							host: `localhost:${agent.port}`,
							"content-length": Buffer.byteLength(rewrittenBody).toString(),
						},
						path: path + url.search,
					},
					(proxyRes) => {
						res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
						proxyRes.pipe(res, { end: true });
					},
				);
				proxyReq.on("error", (err) => {
					process.stderr.write(`[d-pi gateway] Proxy error: ${err.message}\n`);
					if (!res.headersSent) {
						res.writeHead(502, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: `Agent unreachable: ${err.message}` }));
					}
				});
				proxyReq.end(rewrittenBody);
			} catch (_err) {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Failed to process prompt request" }));
				}
			}
			return;
		}

		const proxyReq = request(
			targetUrl,
			{
				method: req.method,
				headers: {
					...req.headers,
					host: `localhost:${agent.port}`,
				},
				path: path + url.search,
			},
			(proxyRes) => {
				res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
				proxyRes.pipe(res, { end: true });
			},
		);

		proxyReq.on("error", (err) => {
			process.stderr.write(`[d-pi gateway] Proxy error: ${err.message}\n`);
			if (!res.headersSent) {
				res.writeHead(502, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: `Agent unreachable: ${err.message}` }));
			}
		});

		req.pipe(proxyReq, { end: true });
	}

	private _readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString()));
			req.on("error", reject);
		});
	}
}
