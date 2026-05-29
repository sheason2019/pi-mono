import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AgentRegistry } from "./agent-registry.ts";

/**
 * HTTP gateway for the d-pi Hub.
 *
 * Routes:
 *   /_hub/agents       GET  → list all agents
 *   /_hub/agents       POST → create agent
 *   /_hub/agents/{id}  DELETE → destroy agent
 *   /_hub/network      GET  → network snapshot
 *   /agents/{id}/*     → reverse proxy to agent's HTTP server
 *   /*                 → reverse proxy to root agent
 */
export class HubGateway {
	private _server: Server | undefined;
	private readonly _registry: AgentRegistry;
	private readonly _onCreateAgent: (
		parentAgentId: string | undefined,
		options: { name: string; cwd?: string; model?: string },
	) => Promise<{ agentId: string; name: string }>;
	private readonly _onDestroyAgent: (agentId: string) => Promise<void>;

	constructor(
		registry: AgentRegistry,
		onCreateAgent: HubGateway["_onCreateAgent"],
		onDestroyAgent: HubGateway["_onDestroyAgent"],
	) {
		this._registry = registry;
		this._onCreateAgent = onCreateAgent;
		this._onDestroyAgent = onDestroyAgent;
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

	private async _handleHubApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
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
			};
			try {
				const result = await this._onCreateAgent(params.parentAgentId, {
					name: params.name,
					cwd: params.cwd,
					model: params.model,
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

		const targetUrl = `http://localhost:${agent.port}${path}`;
		const url = new URL(req.url ?? "/", "http://localhost");

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
