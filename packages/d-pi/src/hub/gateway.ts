import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthSessionInfo, AuthSessionManager } from "../auth/auth-session.ts";
import { injectMeta } from "../extension/message-meta.ts";
import type { SourceConfig } from "../types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { SourceManager } from "./source-manager.ts";

/**
 * HTTP gateway for the d-pi Hub.
 *
 * Routes:
 *   /_hub/agents       GET  → list all agents
 *   /_hub/agents       POST → create agent
 *   /_hub/agents/{id}  DELETE → destroy agent
 *   /_hub/network      GET  → network snapshot
 *   /_hub/sources      GET  → list all sources
 *   /_hub/sources      POST → create source
 *   /_hub/sources/{name} DELETE → destroy source
 *   /agents/{id}/*     → reverse proxy to agent's HTTP server
 *   /*                 → reverse proxy to root agent
 */
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

	constructor(
		registry: AgentRegistry,
		sourceManager: SourceManager,
		onCreateAgent: HubGateway["_onCreateAgent"],
		onDestroyAgent: HubGateway["_onDestroyAgent"],
		auth?: AuthSessionManager,
	) {
		this._registry = registry;
		this._sourceManager = sourceManager;
		this._onCreateAgent = onCreateAgent;
		this._onDestroyAgent = onDestroyAgent;
		this._auth = auth;
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
			try {
				const body = await this._readBody(req);
				const params = JSON.parse(body) as { publicKey?: string };
				if (!params.publicKey) throw new Error("publicKey is required");
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(this._auth.createChallenge(params.publicKey)));
			} catch (err) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		if (path === "/_hub/auth/session" && req.method === "POST") {
			if (!this._auth) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Auth is not enabled" }));
				return;
			}
			try {
				const body = await this._readBody(req);
				const params = JSON.parse(body) as { publicKey?: string; challengeId?: string; signature?: string };
				if (!params.publicKey || !params.challengeId || !params.signature) {
					throw new Error("publicKey, challengeId, and signature are required");
				}
				const session = this._auth.createSession({
					publicKey: params.publicKey,
					challengeId: params.challengeId,
					signature: params.signature,
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(session));
			} catch (err) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
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
			const snapshot = this._registry.getSnapshot();
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

		// GET /_hub/network — network snapshot
		if (path === "/_hub/network" && req.method === "GET") {
			const snapshot = this._registry.getSnapshot();
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

		// Intercept GET /commands to filter out session management commands
		// and inject the /agents command for d-pi connect mode
		const isCommandsRequest = req.method === "GET" && path === "/commands";

		// Intercept POST /prompt to inject message meta header
		const isPromptRequest = req.method === "POST" && path === "/prompt";

		if (isPromptRequest) {
			// Read body, inject meta, then forward
			try {
				const body = await this._readBody(req);
				const parsed = JSON.parse(body) as { text?: string; options?: unknown };
				if (parsed.text) {
					parsed.text = injectMeta(parsed.text, "connect", undefined, undefined, auth.auth);
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
				if (isCommandsRequest && proxyRes.statusCode === 200) {
					// Collect response body, filter commands, then forward
					const chunks: Buffer[] = [];
					proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
					proxyRes.on("end", () => {
						try {
							const commands = JSON.parse(Buffer.concat(chunks).toString()) as Array<{
								name: string;
								description: string;
								argumentHint?: string;
								source?: string;
								[key: string]: unknown;
							}>;
							const blocked = new Set(["resume", "fork", "clone", "new", "tree", "agents"]);
							const filtered = commands.filter((cmd) => !blocked.has(cmd.name));
							filtered.push({
								name: "agents",
								description: "Switch to a different agent (d-pi)",
								source: "dpi-hub",
							});
							const body = JSON.stringify(filtered);
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(body);
						} catch {
							// If parsing fails, forward original response
							const raw = Buffer.concat(chunks).toString();
							res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
							res.end(raw);
						}
					});
				} else {
					res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
					proxyRes.pipe(res, { end: true });
				}
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
