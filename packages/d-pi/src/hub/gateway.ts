import { randomUUID as gatewayRandomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AuthSessionInfo, AuthSessionManager } from "../auth/auth-session.ts";
import { formatDPiMetaMessage } from "../message-meta.ts";
import {
	type DPiJsonValue,
	type DPiServiceActionRequest,
	type DPiServiceEvent,
	type DPiServiceSnapshot,
	dPiServiceActionRequestSchema,
	dPiServiceError,
	toDPiJsonValue,
} from "../service/protocol.ts";
import { parseServiceActionName, toWorkerAction, toWorkerSnapshotQuery } from "../service/session-service.ts";
import { writeServiceSseEvent, writeSseComment } from "../service/sse.ts";
import { discoverTuiComponentFiles, tuiComponentsDir } from "../tui-components/tui-component-discovery.ts";
import type { AgentRecord, HubToWorkerMessage, WorkerToHubMessage } from "../types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { ExecutorRegistry } from "./executor-registry.ts";

type WorkerHttpResponse = Extract<WorkerToHubMessage, { type: "http_response" }>;
interface WorkerHttpResponseWaitOptions {
	req?: IncomingMessage;
	res?: ServerResponse;
	timeoutMs?: number;
}

/**
 * HTTP gateway for the d-pi Hub.
 *
 * Routes:
 *   /_hub/agents       GET  → list all agents
 *   /_hub/agents       POST → create agent
 *   /_hub/agents/{id}  DELETE → destroy agent
 *   /_hub/team       GET  → team snapshot
 *   /agents/{id}/*     → reverse proxy to agent's HTTP server
 *   /*                 → reverse proxy to root agent
 */
export interface HubGatewayOptions {
	/** Max time to wait for an executor to POST a result to
	 *  /_hub/executor/results before failing the pending
	 *  /agents/{id}/remote-call. Default 60_000. */
	remoteCallTimeoutMs?: number;
	workspaceRoot: string;
}

const remoteCallSchema = z.object({
	callId: z.string({ required_error: "callId is required" }).min(1, "callId is required"),
	tool: z.string({ required_error: "tool is required" }).min(1, "tool is required"),
	params: z.unknown().optional(),
});

const authChallengeSchema = z.object({
	publicKey: z.string({ required_error: "publicKey is required" }).min(1, "publicKey is required"),
});

const authSessionSchema = z.object({
	publicKey: z.string({ required_error: "publicKey is required" }).min(1, "publicKey is required"),
	challengeId: z.string({ required_error: "challengeId is required" }).min(1, "challengeId is required"),
	signature: z.string({ required_error: "signature is required" }).min(1, "signature is required"),
});

const createAgentSchema = z.object({
	parentName: z.string().optional(),
	name: z.string({ required_error: "name is required" }).min(1, "name is required"),
	cwd: z.string().optional(),
});

const bindSchema = z.object({
	connectId: z.string({ required_error: "connectId is required" }).min(1, "connectId is required"),
});

const executorResultSchema = z.object({
	connectId: z.string({ required_error: "connectId is required" }).min(1, "connectId is required"),
	callId: z.string({ required_error: "callId is required" }).min(1, "callId is required"),
	ok: z.boolean({ required_error: "ok is required" }),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

const executorRegisterSchema = z.object({
	connectId: z.string({ required_error: "connectId is required" }).min(1, "connectId is required"),
	cwd: z.string({ required_error: "cwd is required" }).min(1, "cwd is required"),
});

const trustedPromptBodySchema = z.object({
	text: z.string(),
});

function zodErrorMessage(err: unknown): string {
	if (err instanceof z.ZodError) {
		return err.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");
	}
	return err instanceof Error ? err.message : String(err);
}

export class HubGateway {
	private _server: Server | undefined;
	private readonly _registry: AgentRegistry;
	private readonly _onCreateAgent: (
		parentName: string | undefined,
		options: { name: string; cwd?: string },
	) => Promise<{ agentName: string }>;
	private readonly _onDestroyAgent: (agentName: string) => Promise<void>;
	private readonly _auth: AuthSessionManager | undefined;
	private readonly _executorRegistry: ExecutorRegistry | undefined;
	private readonly _agentBindings: Map<string, string> = new Map();
	private readonly _remoteCallTimeoutMs: number;
	private readonly _workspaceRoot: string;

	constructor(
		registry: AgentRegistry,
		onCreateAgent: HubGateway["_onCreateAgent"],
		onDestroyAgent: HubGateway["_onDestroyAgent"],
		auth?: AuthSessionManager,
		executorRegistry?: ExecutorRegistry,
		options?: HubGatewayOptions,
	) {
		this._registry = registry;
		this._onCreateAgent = onCreateAgent;
		this._onDestroyAgent = onDestroyAgent;
		this._auth = auth;
		this._executorRegistry = executorRegistry;
		this._remoteCallTimeoutMs = options?.remoteCallTimeoutMs ?? 60_000;
		this._workspaceRoot = options?.workspaceRoot ?? "";
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

				if (path.startsWith("/api/")) {
					await this._handleServiceApi(req, res, path);
					return;
				}

				// /agents/{name}/remote-call — dispatch to the bound executor and block
				// until the executor POSTs the result back. Must be checked BEFORE the
				// generic /agents/{name}/* proxy below. Auth is required: without it,
				// anyone reachable on the hub port could invoke remote tools on a
				// connected user's machine (RCE via the executor).
				const remoteCallMatch = path.match(/^\/agents\/([^/]+)\/remote-call$/);
				if (remoteCallMatch && req.method === "POST") {
					if (!this._authenticate(req)) {
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Unauthorized" }));
						return;
					}
					const agentName = decodeURIComponent(remoteCallMatch[1]!);
					const connectId = this._agentBindings.get(agentName);
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
						const { callId, tool, params } = remoteCallSchema.parse(JSON.parse(body));
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
							const resolved = execReg.resolveOne(connectId, callId, {
								ok: false,
								error: "Remote call timed out",
							});
							if (resolved) {
								process.stderr.write(`[d-pi hub] Remote call ${callId} timed out after ${timeoutMs}ms\n`);
							}
						}, timeoutMs);
						execReg.setPendingTimer(connectId, callId, timer);
						handle.sseConn.send("remote-call", { callId, tool, params });
						// `res` is now held; the executor's result POST (or the
						// timeout above) will resolve it.
						return;
					} catch (err) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: zodErrorMessage(err) }));
						return;
					}
				}

				// SSE endpoint for connect-mode clients: /agents/{name}/events
				// Must be checked BEFORE the generic /agents/{name}/* proxy.
				const sseMatch = path.match(/^\/agents\/([^/]+)\/events$/);
				if (sseMatch && req.method === "GET") {
					this._handleAgentSse(req, res, decodeURIComponent(sseMatch[1]!));
					return;
				}

				// Agent routing: /agents/{name}/* → specific agent (by name)
				const agentMatch = path.match(/^\/agents\/([^/]+)(\/.*)?$/);
				if (agentMatch) {
					const agentName = decodeURIComponent(agentMatch[1]!);
					const agentPath = agentMatch[2] ?? "/";
					await this._proxyToAgent(req, res, agentName, agentPath);
					return;
				}

				// Default: /* → root agent
				const rootAgent = this._registry.getRootAgent();
				if (rootAgent) {
					await this._proxyToAgent(req, res, rootAgent.name, path);
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

	/** Bind an agent name to a connectId so remote tool calls can be dispatched. */
	bindAgent(agentName: string, connectId: string): void {
		this._agentBindings.set(agentName, connectId);
	}

	/** Remove the binding. */
	unbindAgent(agentName: string): void {
		this._agentBindings.delete(agentName);
	}

	/** Number of agent->connectId bindings currently held. Exposed for
	 *  tests and operational introspection; the map itself stays private. */
	get bindingCount(): number {
		return this._agentBindings.size;
	}

	/** Resolve a single binding. Exposed for tests. */
	getBinding(agentName: string): string | undefined {
		return this._agentBindings.get(agentName);
	}

	getBoundAgentName(connectId: string): string | undefined {
		for (const [agentName, boundConnectId] of this._agentBindings) {
			if (boundConnectId === connectId) {
				return agentName;
			}
		}
		return undefined;
	}

	/**
	 * Drop every binding that points at the given connectId. Called when
	 * the executor's SSE channel closes so a stale binding cannot dispatch
	 * to a now-disconnected executor.
	 */
	unbindByConnectId(connectId: string): number {
		let removed = 0;
		for (const [agentName, cid] of this._agentBindings) {
			if (cid === connectId) {
				this._agentBindings.delete(agentName);
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
				const { publicKey } = authChallengeSchema.parse(JSON.parse(body));
				challenge = this._auth.createChallenge(publicKey);
			} catch (err) {
				if (!res.headersSent) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: zodErrorMessage(err) }));
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
				const { publicKey, challengeId, signature } = authSessionSchema.parse(JSON.parse(body));
				session = this._auth.createSession({
					publicKey,
					challengeId,
					signature,
				});
			} catch (err) {
				if (!res.headersSent) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: zodErrorMessage(err) }));
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

		if (path === "/_hub/tui-components" && req.method === "GET") {
			this._handleTuiComponentsManifest(req, res);
			return;
		}

		const tuiComponentMatch = path.match(/^\/_hub\/tui-components\/(.+)$/);
		if (tuiComponentMatch && req.method === "GET") {
			this._handleTuiComponentFile(res, tuiComponentMatch[1]!);
			return;
		}

		// GET /_hub/agents — list all agents
		if (path === "/_hub/agents" && req.method === "GET") {
			const snapshot = this._registry.getTeamSnapshot();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(snapshot.agents));
			return;
		}

		// POST /_hub/agents — create agent
		if (path === "/_hub/agents" && req.method === "POST") {
			const body = await this._readBody(req);
			const params = createAgentSchema.parse(JSON.parse(body));
			try {
				const result = await this._onCreateAgent(params.parentName, {
					name: params.name,
					cwd: params.cwd,
				});
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: zodErrorMessage(err) }));
			}
			return;
		}

		// DELETE /_hub/agents/{name} — destroy agent
		const deleteMatch = path.match(/^\/_hub\/agents\/([^/]+)$/);
		if (deleteMatch && req.method === "DELETE") {
			const agentName = deleteMatch[1];
			try {
				await this._onDestroyAgent(agentName);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: zodErrorMessage(err) }));
			}
			return;
		}

		// POST /_hub/agents/{id}/bind — bind an agent id to a connect id so the
		// hub can dispatch /agents/{id}/remote-call requests to the executor
		// registered for that connect id. Called by `d-pi connect` after the
		// auth handshake.
		//
		// If a previous binding already exists for this agent (e.g. a
		// session on another machine), the new session takes over — the
		// old binding is dropped so the hub routes subsequent remote
		// calls to the new executor. Stale cleanup of the dropped
		// session's executor entry (in the ExecutorRegistry) happens
		// when that session's SSE channel closes, not here.
		const bindMatch = path.match(/^\/_hub\/agents\/([^/]+)\/bind$/);
		if (bindMatch && req.method === "POST") {
			try {
				const body = await this._readBody(req);
				const { connectId } = bindSchema.parse(JSON.parse(body));
				const agentName = decodeURIComponent(bindMatch[1]!);
				// Allow overwrite: unbind any previous session for this
				// agent before installing the new one. The previous
				// session's executor, if still alive, will detect the
				// loss of routing when its next remote call goes to the
				// wrong connectId and exit on its own; its executor
				// registry entry will then be cleaned up via the
				// SSE-close path.
				this.unbindAgent(agentName);
				this.bindAgent(agentName, connectId);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: zodErrorMessage(err) }));
			}
			return;
		}

		// POST /_hub/agents/{id}/unbind — drop the agent→connectId binding.
		// Called by `d-pi connect` on session exit.
		const unbindMatch = path.match(/^\/_hub\/agents\/([^/]+)\/unbind$/);
		if (unbindMatch && req.method === "POST") {
			this.unbindAgent(decodeURIComponent(unbindMatch[1]!));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		// GET /_hub/team — team snapshot
		if (path === "/_hub/team" && req.method === "GET") {
			const snapshot = this._registry.getTeamSnapshot();
			snapshot.executors =
				this._executorRegistry?.list().map((executor) => ({
					...executor,
					boundAgentName: this.getBoundAgentName(executor.connectId),
				})) ?? [];
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(snapshot));
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
				const { connectId, callId, ok, result, error } = executorResultSchema.parse(JSON.parse(body));
				const resolved = execReg.resolveOne(
					connectId,
					callId,
					ok ? { ok: true, result } : { ok: false, error: error ?? "Unknown error" },
				);
				if (!resolved) {
					process.stderr.write(`[d-pi hub] Dropping result for unknown callId ${callId}\n`);
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: zodErrorMessage(err) }));
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
				const { connectId, cwd } = executorRegisterSchema.parse(JSON.parse(body));
				this._executorRegistry.preRegister(connectId, { cwd });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				const msg = zodErrorMessage(err);
				const status = /already registered/i.test(msg) ? 409 : 400;
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: msg }));
			}
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	}

	private async _handleServiceApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
		const snapshotMatch = path.match(/^\/api\/agents\/([^/]+)\/snapshot$/);
		if (snapshotMatch && req.method === "GET") {
			await this._handleServiceSnapshot(req, res, decodeURIComponent(snapshotMatch[1]!));
			return;
		}

		const eventsMatch = path.match(/^\/api\/agents\/([^/]+)\/events$/);
		if (eventsMatch && req.method === "GET") {
			this._handleServiceAgentSse(req, res, decodeURIComponent(eventsMatch[1]!));
			return;
		}

		const actionMatch = path.match(/^\/api\/agents\/([^/]+)\/actions\/([^/]+)$/);
		if (actionMatch && req.method === "POST") {
			await this._handleServiceAction(
				req,
				res,
				decodeURIComponent(actionMatch[1]!),
				decodeURIComponent(actionMatch[2]!),
			);
			return;
		}

		this._writeServiceError(res, 404, "not_found", "Not found");
	}

	private async _handleServiceSnapshot(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
		const auth = this._authenticate(req);
		if (!auth) {
			this._writeServiceError(res, 401, "unauthorized", "Unauthorized");
			return;
		}
		const agent = this._getServiceAgent(res, agentName);
		if (!agent) {
			return;
		}

		const requestId = gatewayRandomUUID();
		const responsePromise = this._waitForWorkerHttpResponse(agent, requestId, { req, res });
		agent.worker.postMessage({
			type: "http_query",
			requestId,
			query: toWorkerSnapshotQuery(),
		} satisfies HubToWorkerMessage);

		const workerResponse = await responsePromise;
		if (!workerResponse) {
			if (req.destroyed || res.destroyed) {
				return;
			}
			this._writeServiceError(res, 504, "timeout", "Agent response timeout");
			return;
		}
		if (workerResponse.status < 200 || workerResponse.status >= 300) {
			let body: DPiJsonValue;
			try {
				body = toDPiJsonValue(workerResponse.body);
			} catch (err) {
				this._writeServiceSerializationError(res, err);
				return;
			}
			this._writeServiceError(res, workerResponse.status, "worker_error", "Worker request failed", {
				status: workerResponse.status,
				body,
			});
			return;
		}

		try {
			this._writeServiceJson(res, 200, this._toServiceSnapshot(agentName, workerResponse.body));
		} catch (err) {
			this._writeServiceSerializationError(res, err);
		}
	}

	private async _handleServiceAction(
		req: IncomingMessage,
		res: ServerResponse,
		agentName: string,
		actionName: string,
	): Promise<void> {
		const auth = this._authenticate(req);
		if (!auth) {
			this._writeServiceError(res, 401, "unauthorized", "Unauthorized");
			return;
		}
		const agent = this._getServiceAgent(res, agentName);
		if (!agent) {
			return;
		}
		const serviceAction = parseServiceActionName(actionName);
		if (!serviceAction) {
			this._writeServiceError(res, 404, "not_found", `Service action not found: ${actionName}`);
			return;
		}

		let parsedBody: unknown;
		try {
			const rawBody = await this._readBody(req);
			parsedBody = JSON.parse(rawBody);
		} catch {
			this._writeServiceError(res, 400, "bad_request", "Failed to parse request body");
			return;
		}
		const actionRequest = this._parseServiceActionRequest(parsedBody);
		if (!actionRequest) {
			this._writeServiceError(res, 400, "bad_request", "text is required");
			return;
		}

		const workerAction = toWorkerAction(serviceAction, actionRequest);

		const requestId = gatewayRandomUUID();
		const responsePromise = this._waitForWorkerHttpResponse(agent, requestId, { req, res });
		agent.worker.postMessage({
			type: "http_request",
			requestId,
			action: workerAction.action,
			data: workerAction.data,
		} satisfies HubToWorkerMessage);

		const workerResponse = await responsePromise;
		if (!workerResponse) {
			if (req.destroyed || res.destroyed) {
				return;
			}
			this._writeServiceError(res, 504, "timeout", "Agent response timeout");
			return;
		}
		if (workerResponse.status < 200 || workerResponse.status >= 300) {
			let body: DPiJsonValue;
			try {
				body = toDPiJsonValue(workerResponse.body);
			} catch (err) {
				this._writeServiceSerializationError(res, err);
				return;
			}
			this._writeServiceError(res, workerResponse.status, "worker_error", "Worker request failed", {
				status: workerResponse.status,
				body,
			});
			return;
		}
		this._writeServiceJson(res, 200, { ok: true });
	}

	private _handleServiceAgentSse(req: IncomingMessage, res: ServerResponse, agentName: string): void {
		const auth = this._authenticate(req);
		if (!auth) {
			this._writeServiceError(res, 401, "unauthorized", "Unauthorized");
			return;
		}
		const agent = this._getServiceAgent(res, agentName);
		if (!agent) {
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		writeSseComment(res, "connected");

		const subscriberId = gatewayRandomUUID();
		const initialRequestId = `service-sse-init-${subscriberId}`;

		const eventHandler = (message: WorkerToHubMessage) => {
			if (message.type === "http_response" && message.requestId === initialRequestId) {
				try {
					const snapshot = this._toServiceSnapshot(agentName, message.body);
					writeServiceSseEvent(res, { type: "snapshot", snapshot });
				} catch (err) {
					this._writeServiceSerializationSseEvent(res, err);
				}
				return;
			}
			if (message.type === "sse_event" && message.subscriberId === subscriberId) {
				try {
					const serviceEvent: DPiServiceEvent =
						message.data === undefined
							? { type: "worker", event: message.event }
							: { type: "worker", event: message.event, data: toDPiJsonValue(message.data) };
					writeServiceSseEvent(res, serviceEvent);
				} catch (err) {
					this._writeServiceSerializationSseEvent(res, err);
				}
			}
		};
		agent.worker.on("message", eventHandler);

		agent.worker.postMessage({
			type: "http_query",
			requestId: initialRequestId,
			query: toWorkerSnapshotQuery(),
		} satisfies HubToWorkerMessage);
		agent.worker.postMessage({
			type: "sse_subscribe",
			subscriberId,
		} satisfies HubToWorkerMessage);

		const heartbeatTimer = setInterval(() => {
			try {
				writeSseComment(res, "heartbeat");
			} catch {
				clearInterval(heartbeatTimer);
			}
		}, 30_000);

		req.on("close", () => {
			clearInterval(heartbeatTimer);
			agent.worker.off("message", eventHandler);
			agent.worker.postMessage({
				type: "sse_unsubscribe",
				subscriberId,
			} satisfies HubToWorkerMessage);
		});
	}

	private _getServiceAgent(res: ServerResponse, agentName: string): AgentRecord | undefined {
		const agent = this._registry.get(agentName);
		if (!agent) {
			this._writeServiceError(res, 404, "not_found", `Agent not found: ${agentName}`, { agentName });
			return undefined;
		}
		return agent;
	}

	private _toServiceSnapshot(agentName: string, state: unknown): DPiServiceSnapshot {
		return {
			agentName,
			state: toDPiJsonValue(state),
		};
	}

	private _parseServiceActionRequest(value: unknown): DPiServiceActionRequest | undefined {
		const result = dPiServiceActionRequestSchema.safeParse(value);
		if (!result.success) {
			return undefined;
		}
		return result.data;
	}

	private _waitForWorkerHttpResponse(
		agent: AgentRecord,
		requestId: string,
		options: WorkerHttpResponseWaitOptions = {},
	): Promise<WorkerHttpResponse | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			const timeoutMs = options.timeoutMs ?? 120_000;
			const req = options.req;
			const res = options.res;

			const settle = (response: WorkerHttpResponse | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				agent.worker.off("message", handler);
				req?.off("close", onRequestClose);
				res?.off("close", onResponseClose);
				resolve(response);
			};

			const timeout = setTimeout(() => settle(undefined), timeoutMs);

			const handler = (message: WorkerToHubMessage) => {
				if (message.type === "http_response" && message.requestId === requestId) {
					settle(message);
				}
			};
			agent.worker.on("message", handler);

			const onRequestClose = () => {
				if (!req?.complete) {
					settle(undefined);
				}
			};
			const onResponseClose = () => {
				if (!res?.writableEnded) {
					settle(undefined);
				}
			};
			if ((req?.destroyed && !req.complete) || (res?.destroyed && !res.writableEnded)) {
				settle(undefined);
				return;
			}
			req?.on("close", onRequestClose);
			res?.on("close", onResponseClose);
		});
	}

	private _writeServiceJson(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	}

	private _writeServiceError(
		res: ServerResponse,
		status: number,
		code: string,
		message: string,
		details?: DPiJsonValue,
	): void {
		this._writeServiceJson(res, status, dPiServiceError(code, message, details));
	}

	private _writeServiceSerializationError(res: ServerResponse, err: unknown): void {
		if (!(err instanceof TypeError) && !(err instanceof z.ZodError)) {
			throw err;
		}
		this._writeServiceError(res, 502, "serialization_error", "Worker response is not JSON-safe");
	}

	private _writeServiceSerializationSseEvent(res: ServerResponse, err: unknown): void {
		try {
			if (!(err instanceof TypeError) && !(err instanceof z.ZodError)) {
				throw err;
			}
			writeServiceSseEvent(res, {
				type: "worker",
				event: "serialization_error",
				data: toDPiJsonValue(dPiServiceError("serialization_error", "Worker response is not JSON-safe")),
			});
		} catch {
			// connection closed
		}
	}

	private _handleTuiComponentsManifest(req: IncomingMessage, res: ServerResponse): void {
		const origin = `http://${req.headers.host ?? "localhost"}`;
		const components = discoverTuiComponentFiles(this._workspaceRoot).map((component) => ({
			name: component.name,
			url: `${origin}/_hub/tui-components/${encodeURIComponent(component.name)}`,
		}));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ components }));
	}

	private _handleTuiComponentFile(res: ServerResponse, encodedName: string): void {
		const name = decodeURIComponent(encodedName);
		if (name !== basename(name) || name.includes("/") || name.includes("\\") || !name.endsWith(".ts")) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "TUI component not found" }));
			return;
		}
		const filePath = this._resolveTuiComponentFile(name);
		if (!filePath) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "TUI component not found" }));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/typescript; charset=utf-8" });
		res.end(readFileSync(filePath, "utf-8"));
	}

	private _resolveTuiComponentFile(name: string): string | undefined {
		const dir = tuiComponentsDir(this._workspaceRoot);
		const filePath = resolve(join(dir, name));
		const rel = relative(resolve(dir), filePath);
		if (rel.startsWith("..") || rel === "" || rel.includes(`..${sep}`) || !existsSync(filePath)) {
			return undefined;
		}
		return filePath;
	}

	private async _proxyToAgent(
		req: IncomingMessage,
		res: ServerResponse,
		agentName: string,
		path: string,
	): Promise<void> {
		const agent = this._registry.get(agentName);
		if (!agent) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Agent not found: ${agentName}` }));
			return;
		}
		const auth = this._authenticate(req);
		if (!auth) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		const method = req.method ?? "GET";
		const cleanPath = path.startsWith("/") ? path.slice(1) : path;

		// Block session management POST endpoints in d-pi connect mode
		const blockedSessionEndpoints = new Set(["new-session", "switch-session", "fork"]);
		if (method === "POST" && blockedSessionEndpoints.has(cleanPath)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Session operations are managed by the d-pi hub" }));
			return;
		}

		// Read the request body (for POST)
		let body: unknown;
		if (method === "POST") {
			try {
				const rawBody = await this._readBody(req);
				if (rawBody) {
					body = JSON.parse(rawBody);
				}
			} catch (_err) {
				if (!res.headersSent) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Failed to parse request body" }));
				}
				return;
			}
		}

		// Dispatch via IPC to the worker
		const requestId = gatewayRandomUUID();
		const needsMeta = new Set(["prompt", "steer", "follow-up"]);
		const payload = needsMeta.has(cleanPath) ? this._withTrustedPromptAuth(body, auth, agentName) : body;

		if (method === "GET") {
			agent.worker.postMessage({
				type: "http_query",
				requestId,
				query: cleanPath,
			} satisfies HubToWorkerMessage);
		} else {
			agent.worker.postMessage({
				type: "http_request",
				requestId,
				action: cleanPath,
				data: payload,
			} satisfies HubToWorkerMessage);
		}

		// Wait for the worker's http_response
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				agent.worker.off("message", handler);
				if (!res.headersSent) {
					res.writeHead(504, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Agent response timeout" }));
				}
				resolve();
			}, 120_000);

			const handler = (message: WorkerToHubMessage) => {
				if (message.type === "http_response" && message.requestId === requestId) {
					clearTimeout(timeout);
					agent.worker.off("message", handler);
					if (!res.headersSent) {
						res.writeHead(message.status, { "Content-Type": "application/json" });
						res.end(JSON.stringify(message.body));
					}
					resolve();
				}
			};
			agent.worker.on("message", handler);
		});
	}

	/**
	 * Handle a connect-mode SSE subscription for a specific agent.
	 *
	 * The gateway holds the SSE connection directly (no HTTP proxy to
	 * an agent port). It sends an `sse_subscribe` IPC message to the
	 * agent's worker, which registers the subscriber and forwards all
	 * proxy events back as `sse_event` IPC messages. The gateway then
	 * writes them as SSE to the client's HTTP connection.
	 *
	 * Multiple clients can subscribe to the same agent simultaneously
	 * (multi-end connect). Each gets a unique subscriberId.
	 */
	private _handleAgentSse(req: IncomingMessage, res: ServerResponse, agentName: string): void {
		const agent = this._registry.get(agentName);
		if (!agent) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `Agent not found: ${agentName}` }));
			return;
		}
		const auth = this._authenticate(req);
		if (!auth) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("\n");

		const subscriberId = gatewayRandomUUID();

		// Subscribe to the worker's events
		agent.worker.postMessage({
			type: "sse_subscribe",
			subscriberId,
		} satisfies HubToWorkerMessage);

		// Heartbeat
		const heartbeatTimer = setInterval(() => {
			try {
				res.write(": heartbeat\n\n");
			} catch {
				clearInterval(heartbeatTimer);
			}
		}, 30_000);

		// Listen for events from the worker
		const eventHandler = (message: WorkerToHubMessage) => {
			if (message.type === "sse_event" && message.subscriberId === subscriberId) {
				try {
					const data = JSON.stringify(message.data);
					res.write(`event: ${message.event}\ndata: ${data}\n\n`);
				} catch {
					// connection closed
				}
			}
		};
		agent.worker.on("message", eventHandler);

		// Cleanup on disconnect
		req.on("close", () => {
			clearInterval(heartbeatTimer);
			agent.worker.off("message", eventHandler);
			agent.worker.postMessage({
				type: "sse_unsubscribe",
				subscriberId,
			} satisfies HubToWorkerMessage);
		});
	}

	private _readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString()));
			req.on("error", reject);
		});
	}

	private _withTrustedPromptAuth(body: unknown, session: AuthSessionInfo, agentName: string): unknown {
		const parsed = trustedPromptBodySchema.safeParse(body);
		if (!parsed.success) {
			return body;
		}
		const connectId = this._agentBindings.get(agentName);
		return {
			...parsed.data,
			text: formatDPiMetaMessage(
				{
					sourceType: "connect",
					auth: session.auth,
					...(connectId === undefined ? {} : { connectId }),
				},
				parsed.data.text,
			),
			auth: session.auth,
		};
	}
}
