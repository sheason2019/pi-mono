import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { AuthSessionManager } from "../auth/auth-session.ts";
import { DEFAULT_AGENT_PORT_START, DEFAULT_HUB_PORT } from "../defaults.ts";
import { injectMeta } from "../extension/message-meta.ts";
import type {
	AgentConfig,
	AgentNetworkSnapshot,
	CreateAgentResult,
	CreateSourceResult,
	DestroyAgentResult,
	DestroySourceResult,
	HubConfig,
	HubToWorkerMessage,
	ListSourcesResult,
	SendMessageResult,
	SubscribeSourceResult,
	UnsubscribeSourceResult,
	WorkerToHubMessage,
} from "../types.ts";
import { loadWorkspaceContext } from "../workspace/workspace.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { ExecutorRegistry } from "./executor-registry.ts";
import { HubGateway } from "./gateway.ts";
import { SourceManager } from "./source-manager.ts";

const AGENT_CONFIG_FILE = "agent.json";

export class Hub {
	private readonly _registry: AgentRegistry;
	private readonly _gateway: HubGateway;
	private readonly _sourceManager: SourceManager;
	private readonly _executorRegistry: ExecutorRegistry;
	private readonly _config: HubConfig;

	constructor(config: HubConfig) {
		this._config = config;
		const portStart = config.agentPortStart ?? DEFAULT_AGENT_PORT_START;
		this._registry = new AgentRegistry(portStart);

		this._sourceManager = new SourceManager((sourceName, content, subscriberAgentIds, deliverAs, drainMode) => {
			const metaContent = injectMeta(content, "source", undefined, { sourceName });
			for (const agentId of subscriberAgentIds) {
				const record = this._registry.get(agentId);
				if (record) {
					record.worker.postMessage({
						type: "message",
						fromAgentId: `source:${sourceName}`,
						content: metaContent,
						sourceName,
						deliverAs,
						drainMode,
					} satisfies HubToWorkerMessage);
				}
			}
		});

		this._executorRegistry = new ExecutorRegistry();

		this._gateway = new HubGateway(
			this._registry,
			this._sourceManager,
			(parentId, options) => this.createAgent(parentId, options),
			(agentId) => this.destroyAgent(agentId),
			new AuthSessionManager(config.workspaceRoot),
			this._executorRegistry,
		);
	}

	async start(): Promise<void> {
		const hubPort = this._config.port ?? DEFAULT_HUB_PORT;

		// 1. Start gateway
		await this._gateway.start(hubPort);

		// 2. Discover and start persisted agents from agents/ directory
		const agentsDir = join(this._config.workspaceRoot, "agents");
		if (existsSync(agentsDir)) {
			const entries = readdirSync(agentsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const configPath = join(agentsDir, entry.name, AGENT_CONFIG_FILE);
				if (!existsSync(configPath)) continue;

				try {
					// Strict JSON parse. The init template (and every persisted
					// agent.json) is canonical JSON emitted by JSON.stringify, so
					// no comment-stripping workaround is needed. A SyntaxError
					// here means the file is corrupt or hand-edited with `//` /
					// trailing commas — surface it instead of papering over it.
					const agentRaw = readFileSync(configPath, "utf-8");
					const agentConfig: AgentConfig = JSON.parse(agentRaw);
					process.stderr.write(`[d-pi hub] Restoring agent "${agentConfig.name}" from ${entry.name}/\n`);
					// Resolve parentId from parentName in persisted config
					const parentAgentId = agentConfig.parentName
						? this._registry.getByName(agentConfig.parentName)?.id
						: undefined;
					await this.createAgent(parentAgentId, {
						name: agentConfig.name,
						roles: agentConfig.roles,
						model: agentConfig.model,
						sessionId: agentConfig.sessionId,
						includeTools: agentConfig.includeTools,
						excludeTools: agentConfig.excludeTools,
					});
				} catch (err) {
					process.stderr.write(
						`[d-pi hub] Failed to restore agent from ${entry.name}/: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				}
			}
		}

		// 3. Ensure root agent exists
		if (!this._registry.getByName("root")) {
			await this.createAgent(undefined, {
				name: "root",
				model: this._config.model,
			});
		}

		process.stderr.write(`[d-pi hub] Workspace: ${this._config.workspaceRoot}\n`);
		process.stderr.write(`[d-pi hub] Listening on port ${hubPort}\n`);
		process.stderr.write(`[d-pi hub] Connect with: d-pi connect <local-user@http://localhost:${hubPort}>\n`);
	}

	async createAgent(
		parentAgentId: string | undefined,
		options: {
			name: string;
			cwd?: string;
			model?: string;
			roles?: string[];
			sessionId?: string;
			includeTools?: string[];
			excludeTools?: string[];
		},
	): Promise<CreateAgentResult> {
		// Mutex validation: includeTools and excludeTools cannot both be set.
		// This is a defensive second-layer check — the extension layer also
		// rejects the combination, but in-process callers (e.g. agent
		// restoration on hub restart) go through this code path directly.
		if (options.includeTools && options.excludeTools) {
			throw new Error(
				"includeTools and excludeTools are mutually exclusive; provide at most one. Both omitted = inherit all tools.",
			);
		}

		// Check name uniqueness
		if (this._registry.getByName(options.name)) {
			throw new Error(`Agent with name "${options.name}" already exists`);
		}

		const agentId = crypto.randomUUID();
		const port = await this._registry.allocatePort();

		// Agent cwd: workspaceRoot/agents/<name>/ (create if needed)
		const agentDir = options.cwd ?? join(this._config.workspaceRoot, "agents", options.name);
		mkdirSync(agentDir, { recursive: true });

		// Resolve parent name for persistence
		const parentName = parentAgentId ? this._registry.get(parentAgentId)?.name : undefined;
		const workspaceContext = loadWorkspaceContext(this._config.workspaceRoot, {
			agentName: options.name,
			roles: options.roles,
		});

		// Write agent.json
		const agentConfig: AgentConfig = {
			name: options.name,
			parentName,
			roles: options.roles,
			model: options.model,
			sessionId: options.sessionId,
			includeTools: options.includeTools,
			excludeTools: options.excludeTools,
		};
		writeFileSync(join(agentDir, AGENT_CONFIG_FILE), `${JSON.stringify(agentConfig, null, "\t")}\n`);

		// Compute isolated session directory
		const sessionDir = join(this._config.workspaceRoot, ".dpi-sessions", options.name);

		// Merge tools config: workspace defaults + agent overrides
		const includeTools = options.includeTools ?? this._config.workspaceConfig.includeTools;
		const excludeTools = options.excludeTools ?? this._config.workspaceConfig.excludeTools;

		process.stderr.write(
			`[d-pi hub] Creating agent "${options.name}" (${agentId}) on port ${port}, cwd=${agentDir}\n`,
		);

		// Create worker
		const worker = new Worker(new URL("../worker/agent-worker.js", import.meta.url), {
			workerData: {
				agentId,
				port,
				cwd: agentDir,
				model: options.model,
				parentAgentId,
				agentName: options.name,
				workspaceContext,
				sessionId: options.sessionId,
				sessionDir,
				includeTools,
				excludeTools,
			},
		});

		// Set up IPC
		worker.on("message", (message: WorkerToHubMessage) => {
			this._handleWorkerMessage(worker, message);
		});

		worker.on("error", (err) => {
			process.stderr.write(`[d-pi hub] Worker ${agentId} error: ${err.message}\n`);
			this._registry.updateStatus(agentId, "error");
		});

		worker.on("exit", (code) => {
			if (code !== 0) {
				process.stderr.write(`[d-pi hub] Worker ${agentId} exited with code ${code}\n`);
			}
			this._registry.updateStatus(agentId, "destroyed");
		});

		// Register in registry (status: starting)
		this._registry.register({
			id: agentId,
			name: options.name,
			parentId: parentAgentId,
			children: [],
			port,
			status: "starting",
			worker,
			cwd: agentDir,
			model: options.model,
		});

		// Wait for ready signal
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				worker.off("message", readyHandler);
				process.stderr.write(`[d-pi hub] Worker ${agentId} startup timeout after 120s\n`);
				reject(new Error(`Worker ${agentId} startup timeout`));
			}, 120_000);

			const readyHandler = (message: WorkerToHubMessage) => {
				if (message.type === "ready" && message.agentId === agentId) {
					clearTimeout(timeout);
					this._registry.updateStatus(agentId, "ready");
					worker.off("message", readyHandler);
					process.stderr.write(`[d-pi hub] Agent "${options.name}" (${agentId}) is ready\n`);
					resolve({ agentId, name: options.name });
				}
				if (message.type === "error" && message.agentId === agentId) {
					clearTimeout(timeout);
					worker.off("message", readyHandler);
					process.stderr.write(`[d-pi hub] Agent "${options.name}" (${agentId}) error: ${message.error}\n`);
					reject(new Error(message.error));
				}
			};
			worker.on("message", readyHandler);
		});
	}

	async destroyAgent(agentIdOrName: string): Promise<void> {
		// Resolve by name if not a UUID
		const record = this._registry.get(agentIdOrName) ?? this._registry.getByName(agentIdOrName);
		if (!record) {
			throw new Error(`Agent not found: ${agentIdOrName}`);
		}
		const agentId = record.id;

		// Safety check: agent must not have children
		if (record.children.length > 0) {
			const childNames = record.children.map((cid) => this._registry.get(cid)?.name ?? cid).join(", ");
			throw new Error(
				`Cannot destroy agent "${record.name}": it has ${record.children.length} child agent(s) (${childNames}). Destroy all children first.`,
			);
		}

		// Safety check: agent must not be creator of any active source
		const createdSources = this._sourceManager.getSourcesByCreator(agentId);
		if (createdSources.length > 0) {
			throw new Error(
				`Cannot destroy agent "${record.name}": it is the creator of source(s) [${createdSources.join(", ")}]. Destroy or transfer ownership of those sources first.`,
			);
		}

		// Auto-unsubscribe from all sources
		this._sourceManager.removeAgentSubscriptions(agentId);

		// Collect all workers to terminate before unregister removes them from registry
		const destroyedIds = [agentId];

		const workersToTerminate: Array<{ id: string; worker: Worker; cwd: string }> = [];
		for (const id of destroyedIds) {
			const r = this._registry.get(id);
			if (r) {
				workersToTerminate.push({ id, worker: r.worker, cwd: r.cwd });
			}
		}

		// Unregister (no descendants since children check passed)
		this._registry.unregister(agentId);

		// Remove agent.json and directory for all destroyed agents
		for (const { cwd } of workersToTerminate) {
			const configPath = join(cwd, AGENT_CONFIG_FILE);
			if (existsSync(configPath)) {
				rmSync(configPath);
			}
			// Remove the agent directory if it's under the workspace agents/ dir
			const agentsDir = join(this._config.workspaceRoot, "agents");
			if (cwd.startsWith(agentsDir)) {
				rmSync(cwd, { recursive: true, force: true });
			}
		}

		// Send destroy to all workers and wait for confirmation (or timeout)
		const destroyPromises = workersToTerminate.map(async ({ id, worker }) => {
			try {
				worker.postMessage({ type: "destroy" } satisfies HubToWorkerMessage);
				// Wait for worker to exit or timeout after 5s
				await Promise.race([
					new Promise<void>((resolve) => {
						const handler = (message: WorkerToHubMessage) => {
							if (message.type === "status_update" && message.agentId === id && message.status === "destroyed") {
								worker.off("message", handler);
								resolve();
							}
						};
						worker.on("message", handler);
					}),
					new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
				]);
			} catch {
				// Worker may already be dead
			}
			await worker.terminate();
		});

		await Promise.all(destroyPromises);
	}

	private _handleWorkerMessage(_worker: Worker, message: WorkerToHubMessage): void {
		switch (message.type) {
			case "ready":
				// Handled in createAgent() via the readyHandler
				break;

			case "error":
				process.stderr.write(`[d-pi hub] Agent ${message.agentId} error: ${message.error}\n`);
				this._registry.updateStatus(message.agentId, "error");
				break;

			case "status_update":
				this._registry.updateStatus(message.agentId, message.status);
				break;

			case "tool_call":
				this._handleToolCall(message.callId, message.tool, message.params, message.agentId);
				break;

			case "tool_call_timeout":
				process.stderr.write(`[d-pi hub] Tool call ${message.callId} from agent ${message.agentId} timed out\n`);
				break;
		}
	}

	private async _handleToolCall(callId: string, tool: string, params: unknown, fromAgentId: string): Promise<void> {
		const agent = this._registry.get(fromAgentId);
		if (!agent) {
			process.stderr.write(`[d-pi hub] _handleToolCall: agent not found for ${fromAgentId}\n`);
			return;
		}

		try {
			let result: unknown;

			switch (tool) {
				case "send_message": {
					const p = params as { agent_id: string; message: string };
					const targetAgent = this._registry.get(p.agent_id) ?? this._registry.getByName(p.agent_id);
					if (!targetAgent) {
						result = { ok: false, error: `Agent not found: ${p.agent_id}` } satisfies SendMessageResult;
					} else {
						const metaContent = injectMeta(p.message, "agent", undefined, { agentId: fromAgentId });
						targetAgent.worker.postMessage({
							type: "message",
							fromAgentId,
							content: metaContent,
						} satisfies HubToWorkerMessage);
						result = { ok: true } satisfies SendMessageResult;
					}
					break;
				}

				case "create_agent": {
					const p = params as {
						name: string;
						cwd?: string;
						model?: string;
						roles?: string[];
						includeTools?: string[];
						excludeTools?: string[];
					};
					const created = await this.createAgent(fromAgentId, {
						name: p.name,
						cwd: p.cwd,
						model: p.model,
						roles: p.roles,
						includeTools: p.includeTools,
						excludeTools: p.excludeTools,
					});
					result = { agentId: created.agentId, name: created.name } satisfies CreateAgentResult;
					break;
				}

				case "destroy_agent": {
					const p = params as { agent_id: string };
					try {
						await this.destroyAgent(p.agent_id);
						result = { ok: true } satisfies DestroyAgentResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies DestroyAgentResult;
					}
					break;
				}

				case "agent_network": {
					result = this._registry.getSnapshot() satisfies AgentNetworkSnapshot;
					break;
				}

				case "create_source": {
					const p = params as {
						name: string;
						command: string;
						args?: string[];
						cwd?: string;
						env?: Record<string, string>;
					};
					try {
						this._sourceManager.createSource(
							{
								name: p.name,
								command: p.command,
								args: p.args,
								cwd: p.cwd,
								env: p.env,
							},
							fromAgentId,
						);
						result = { ok: true } satisfies CreateSourceResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies CreateSourceResult;
					}
					break;
				}

				case "destroy_source": {
					const p = params as { name: string };
					try {
						this._sourceManager.destroySource(p.name);
						result = { ok: true } satisfies DestroySourceResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies DestroySourceResult;
					}
					break;
				}

				case "subscribe_source": {
					const p = params as { source_name: string };
					try {
						this._sourceManager.subscribe(p.source_name, fromAgentId);
						result = { ok: true } satisfies SubscribeSourceResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies SubscribeSourceResult;
					}
					break;
				}

				case "unsubscribe_source": {
					const p = params as { source_name: string };
					try {
						this._sourceManager.unsubscribe(p.source_name, fromAgentId);
						result = { ok: true } satisfies UnsubscribeSourceResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies UnsubscribeSourceResult;
					}
					break;
				}

				case "list_sources": {
					result = { sources: this._sourceManager.listSources() } satisfies ListSourcesResult;
					break;
				}

				default:
					result = { error: `Unknown tool: ${tool}` };
			}

			agent.worker.postMessage({
				type: "tool_result",
				callId,
				result,
			} satisfies HubToWorkerMessage);
		} catch (err) {
			agent.worker.postMessage({
				type: "tool_result",
				callId,
				result: { error: err instanceof Error ? err.message : String(err) },
			} satisfies HubToWorkerMessage);
		}
	}
}
