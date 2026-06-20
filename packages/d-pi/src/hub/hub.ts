import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { AGENT_SESSION_DIR, AGENT_TS_FILE, writeAgentTsConfig } from "../agent-config.ts";
import { AuthSessionManager } from "../auth/auth-session.ts";
import { DEFAULT_HUB_PORT } from "../defaults.ts";
import { injectMeta } from "../extension/message-meta.ts";
import type {
	AgentConfig,
	CreateAgentResult,
	DeleteSourceResult,
	DestroyAgentResult,
	GetSourceResult,
	HubConfig,
	HubToWorkerMessage,
	SendMessageResult,
	SetSourceResult,
	TeamSnapshot,
	WorkerToHubMessage,
} from "../types.ts";
import { loadWorkspaceContext } from "../workspace/workspace.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { ExecutorRegistry } from "./executor-registry.ts";
import { HubGateway } from "./gateway.ts";
import { discoverPersistedAgents, orderAgentsForRestore } from "./restore-agents.ts";
import { SourceManager } from "./source-manager.ts";
import { discoverSourceConfigs } from "./source-persistence.ts";

export class Hub {
	private readonly _registry: AgentRegistry;
	private readonly _gateway: HubGateway;
	private readonly _sourceManager: SourceManager;
	private readonly _executorRegistry: ExecutorRegistry;
	private readonly _config: HubConfig;
	/**
	 * Max time to wait for an executor result before failing the
	 * dispatch. Mirrors HubGateway's `remoteCallTimeoutMs` so the IPC
	 * path (case "dispatch") and the HTTP path
	 * (`/agents/{name}/remote-call`) time out consistently.
	 */
	private readonly _remoteCallTimeoutMs: number;

	constructor(config: HubConfig) {
		this._config = config;
		this._remoteCallTimeoutMs = config.remoteCallTimeoutMs ?? 60_000;
		this._registry = new AgentRegistry();

		this._sourceManager = new SourceManager(
			(sourceName, content, subscriberNames, mode) => {
				const metaContent = injectMeta(content, "source", undefined, { sourceName });
				for (const agentName of subscriberNames) {
					const record = this._registry.get(agentName);
					if (record) {
						record.worker.postMessage({
							type: "message",
							fromAgentName: `source:${sourceName}`,
							content: metaContent,
							sourceName,
							mode,
						} satisfies HubToWorkerMessage);
					}
				}
			},
			// Pass the workspace root so the source manager persists
			// `sources/<name>/source.json` on setSource and removes it
			// on deleteSource. Restore happens in `start()` via
			// `restoreSourceConfigs()`.
			{ workspaceRoot: config.workspaceRoot },
		);

		this._executorRegistry = new ExecutorRegistry();

		this._gateway = new HubGateway(
			this._registry,
			this._sourceManager,
			(parentName, options) => this.createAgent(parentName, options),
			(agentName) => this.destroyAgent(agentName),
			new AuthSessionManager(config.workspaceRoot),
			this._executorRegistry,
			{ remoteCallTimeoutMs: this._remoteCallTimeoutMs },
		);
	}

	async start(): Promise<void> {
		const hubPort = this._config.port ?? DEFAULT_HUB_PORT;

		// 1. Start gateway
		await this._gateway.start(hubPort);

		// 2. Discover and start persisted agents from agents/ directory
		await this._restorePersistedAgents();

		// 3. Ensure root agent exists
		if (!this._registry.getByName("root")) {
			await this.createAgent(undefined, {
				name: "root",
				model: this._config.model,
			});
		}

		// 4. Restore persisted sources (`sources/<name>/source.json`).
		// Done AFTER the agent registry is fully populated so the
		// subscriber-rehydration step can match persisted agent names
		// against the live registry. Sources whose persisted creator
		// / subscriber set has no remaining agents still come back
		// online — the source subprocess is independent of agent
		// lifecycle — but start with an empty subscribers set.
		this._restorePersistedSources();

		process.stderr.write(`[d-pi hub] Workspace: ${this._config.workspaceRoot}\n`);
		process.stderr.write(`[d-pi hub] Listening on port ${hubPort}\n`);
		process.stderr.write(`[d-pi hub] Connect with: d-pi connect <local-user@http://localhost:${hubPort}>\n`);
	}

	/**
	 * Discover and start persisted agents from `agents/<name>/agent.ts`.
	 *
	 * Two-pass restore:
	 *   1. Read every `agent.ts` into a list (cheap, no I/O ordering issues).
	 *   2. Sort by `parentName` chain depth (root = depth 0, then 1, 2, ...),
	 *      then alphabetically by name. Process in that order so a child's
	 *      `parentName` is always resolvable when it is restored.
	 *
	 * Why this matters: the old code iterated `readdirSync(agentsDir, ...)` in
	 * raw filesystem order, which is not portable (e.g. on macOS HFS+/APFS the
	 * order is insertion / case-insensitive / locale-dependent). If a child was
	 * read before its parent, `getByName(parentName)` returned `undefined` and
	 * the child was created as an orphan — the very bug the user reported, where
	 * `llm-wiki` showed up at the same depth as `root` in the TUI's "Switch to
	 * agent" selector. Sorting by depth makes the restore deterministic across
	 * filesystems and immune to the directory entry order.
	 *
	 * Cycle detection: a cycle in the parent chain (e.g. A's parent is B and
	 * B's parent is A) is treated as a corrupted config — the offending entry
	 * is restored as an orphan (parentName becomes undefined) and a warning is
	 * logged. This matches the spirit of the strict-JSON `//` comment handling:
	 * surface corruption rather than paper over it.
	 */
	private async _restorePersistedAgents(): Promise<void> {
		const discovered = await discoverPersistedAgents(this._config.workspaceRoot);
		const ordered = orderAgentsForRestore(discovered);

		for (const d of ordered) {
			let parentName = d.config.parentName;
			if (d.cycle) {
				process.stderr.write(
					`[d-pi hub] Cycle detected in parent chain starting at "${d.config.name}" (${d.entryName}/); restoring as orphan.\n`,
				);
				parentName = undefined;
			}
			process.stderr.write(`[d-pi hub] Restoring agent "${d.config.name}" from ${d.entryName}/\n`);
			const parentNameForCreate = parentName;
			if (parentName && !this._registry.getByName(parentName)) {
				// parentName is set but the named parent didn't make it into
				// the registry during this restore pass (e.g. its agent.ts
				// is missing or filtered out). Surface this loudly — the
				// depth-sort above is supposed to prevent it, but we still
				// want a clear signal if a parent agent.ts is hand-deleted
				// mid-edit.
				process.stderr.write(
					`[d-pi hub] Parent agent "${parentName}" not found while restoring "${d.config.name}" (${d.entryName}/); restoring as orphan.\n`,
				);
			}
			try {
				await this.createAgent(parentNameForCreate, {
					name: d.config.name,
					description: d.config.description,
					roles: d.config.roles,
					model: d.config.model,
					includeTools: d.config.includeTools,
					excludeTools: d.config.excludeTools,
					persistDefinition: false,
				});
			} catch (err) {
				process.stderr.write(
					`[d-pi hub] Failed to restore agent from ${d.entryName}/: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}

	/**
	 * Restore every persisted source from `sources/<name>/source.json`.
	 * Re-spawns the subprocess and re-attaches to subscribers that
	 * are still alive in the registry. See `SourceManager.restoreFromConfigs`
	 * for the per-source details.
	 *
	 * Subscribers that were recorded but no longer have a live agent
	 * (their `agent.ts` was deleted, or the agent failed to start)
	 * are silently dropped — the source can re-acquire them later
	 * by calling set_source with an updated subscribers list if the agent reappears.
	 */
	private _restorePersistedSources(): void {
		const files = discoverSourceConfigs(this._config.workspaceRoot);
		if (files.length === 0) return;
		const liveAgentNames = new Set<string>();
		for (const record of this._registry.getAll()) {
			liveAgentNames.add(record.name);
		}
		this._sourceManager.restoreFromConfigs(files, liveAgentNames);
	}

	async createAgent(
		parentName: string | undefined,
		options: {
			name: string;
			cwd?: string;
			description?: string;
			model?: string;
			roles?: string[];
			includeTools?: string[];
			excludeTools?: string[];
			persistDefinition?: boolean;
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

		// Parent invariant: a non-undefined parentName MUST refer to a live
		// agent in the registry. The runtime create_agent path (worker → hub)
		// already guarantees this because the worker passes its own name
		// from workerData. The persisted-restore path now guarantees it
		// via the depth-sort in `_restorePersistedAgents`. This check is a
		// third-line defense against in-process callers that hand us a
		// stale or fabricated name.
		//
		// The design intent — documented in the create_agent tool description
		// — is that every new agent is a DIRECT child of the caller, never a
		// sibling or arbitrary depth. Anything else would break the agent
		// tree's parent/child invariant and produce the "orphan at the same
		// depth as the caller" bug.
		if (parentName !== undefined && !this._registry.get(parentName)) {
			throw new Error(
				`Cannot create agent "${options.name}": parent agent "${parentName}" not found in registry. ` +
					`The create_agent contract is that the new agent is a direct child of the caller; the caller must be a registered agent.`,
			);
		}

		// Check name uniqueness (names are the unique key, see the
		// "name is identity" rationale in the changelog)
		if (this._registry.getByName(options.name)) {
			throw new Error(`Agent with name "${options.name}" already exists`);
		}

		// Agent cwd: workspaceRoot/agents/<name>/ (create if needed)
		const agentDir = options.cwd ?? join(this._config.workspaceRoot, "agents", options.name);
		mkdirSync(agentDir, { recursive: true });

		const workspaceContext = loadWorkspaceContext(this._config.workspaceRoot, {
			agentName: options.name,
			roles: options.roles,
		});

		const agentConfig: AgentConfig = {
			name: options.name,
			parentName,
			description: options.description,
			roles: options.roles,
			model: options.model,
			includeTools: options.includeTools,
			excludeTools: options.excludeTools,
		};
		if (options.persistDefinition !== false) {
			writeAgentTsConfig(agentDir, agentConfig);
		}

		// Compute isolated session directory
		const sessionDir = join(agentDir, AGENT_SESSION_DIR);

		// Tools config is agent-only — declared in agent.ts and passed via
		// the create_agent tool call. There is no workspace-level fallback.
		const includeTools = options.includeTools;
		const excludeTools = options.excludeTools;

		process.stderr.write(`[d-pi hub] Creating agent "${options.name}" (IPC mode), cwd=${agentDir}\n`);

		// Create worker — `agentName` is the agent's identity (no separate id)
		const worker = new Worker(new URL("../worker/agent-worker.js", import.meta.url), {
			workerData: {
				agentName: options.name,
				parentName,
				cwd: agentDir,
				model: options.model,
				workspaceContext,
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
			process.stderr.write(`[d-pi hub] Worker ${options.name} error: ${err.message}\n`);
			this._registry.updateStatus(options.name, "error");
		});

		worker.on("exit", (code) => {
			if (code !== 0) {
				process.stderr.write(`[d-pi hub] Worker ${options.name} exited with code ${code}\n`);
			}
			this._registry.updateStatus(options.name, "destroyed");
		});

		// Register in registry (status: starting) — keyed by name
		this._registry.register({
			name: options.name,
			parentName,
			children: [],
			status: "starting",
			worker,
			cwd: agentDir,
			model: options.model,
		});

		// Wait for ready signal
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				worker.off("message", readyHandler);
				process.stderr.write(`[d-pi hub] Worker ${options.name} startup timeout after 120s\n`);
				reject(new Error(`Worker ${options.name} startup timeout`));
			}, 120_000);

			const readyHandler = (message: WorkerToHubMessage) => {
				if (message.type === "ready" && message.agentName === options.name) {
					clearTimeout(timeout);
					this._registry.updateStatus(options.name, "ready");
					worker.off("message", readyHandler);
					process.stderr.write(`[d-pi hub] Agent "${options.name}" is ready\n`);
					resolve({ agentName: options.name });
				}
				if (message.type === "error" && message.agentName === options.name) {
					clearTimeout(timeout);
					worker.off("message", readyHandler);
					process.stderr.write(`[d-pi hub] Agent "${options.name}" error: ${message.error}\n`);
					reject(new Error(message.error));
				}
			};
			worker.on("message", readyHandler);
		});
	}

	async destroyAgent(agentName: string): Promise<void> {
		// Names are the unique key; the registry is name-keyed, so a single
		// lookup suffices. The previous "name or id" fallback is no longer
		// needed — the only valid identifier IS the name.
		const record = this._registry.get(agentName);
		if (!record) {
			throw new Error(`Agent not found: ${agentName}`);
		}

		// Safety check: agent must not have children
		if (record.children.length > 0) {
			const childNames = record.children.map((cname) => this._registry.get(cname)?.name ?? cname).join(", ");
			throw new Error(
				`Cannot destroy agent "${record.name}": it has ${record.children.length} child agent(s) (${childNames}). Destroy all children first.`,
			);
		}

		// Safety check: agent must not be creator of any active source
		const createdSources = this._sourceManager.getSourcesByCreator(agentName);
		if (createdSources.length > 0) {
			throw new Error(
				`Cannot destroy agent "${record.name}": it is the creator of source(s) [${createdSources.join(", ")}]. Destroy or transfer ownership of those sources first.`,
			);
		}

		// Auto-unsubscribe from all sources
		this._sourceManager.removeAgentSubscriptions(agentName);

		// Collect all workers to terminate before unregister removes them from registry
		const workersToTerminate: Array<{ name: string; worker: Worker; cwd: string }> = [];
		const r = this._registry.get(agentName);
		if (r) {
			workersToTerminate.push({ name: agentName, worker: r.worker, cwd: r.cwd });
		}

		// Unregister (no descendants since children check passed)
		this._registry.unregister(agentName);

		// Remove agent.ts and directory for all destroyed agents
		for (const { cwd } of workersToTerminate) {
			const configPath = join(cwd, AGENT_TS_FILE);
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
		const destroyPromises = workersToTerminate.map(async ({ name, worker }) => {
			try {
				worker.postMessage({ type: "destroy" } satisfies HubToWorkerMessage);
				// Wait for worker to exit or timeout after 5s
				await Promise.race([
					new Promise<void>((resolve) => {
						const handler = (message: WorkerToHubMessage) => {
							if (
								message.type === "status_update" &&
								message.agentName === name &&
								message.status === "destroyed"
							) {
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
				process.stderr.write(`[d-pi hub] Agent ${message.agentName} error: ${message.error}\n`);
				this._registry.updateStatus(message.agentName, "error");
				break;

			case "status_update":
				this._registry.updateStatus(message.agentName, message.status);
				break;

			case "tool_call":
				this._handleToolCall(message.callId, message.tool, message.params, message.agentName);
				break;

			case "tool_call_timeout":
				process.stderr.write(`[d-pi hub] Tool call ${message.callId} from agent ${message.agentName} timed out\n`);
				break;
		}
	}

	private async _handleToolCall(callId: string, tool: string, params: unknown, fromAgentName: string): Promise<void> {
		const agent = this._registry.get(fromAgentName);
		if (!agent) {
			process.stderr.write(`[d-pi hub] _handleToolCall: agent not found for ${fromAgentName}\n`);
			return;
		}

		try {
			let result: unknown;

			switch (tool) {
				case "send_message": {
					const p = params as { agent_id: string; message: string; mode?: "next" | "steer" };
					// Names are the unique key — the registry is name-keyed
					// so a single get() lookup suffices. No more "name or id"
					// disambiguation; the user always passes the agent's name.
					const targetAgent = this._registry.get(p.agent_id);
					if (!targetAgent) {
						result = { ok: false, error: `Agent not found: ${p.agent_id}` } satisfies SendMessageResult;
					} else {
						const metaContent = injectMeta(p.message, "agent", undefined, {
							agentName: fromAgentName,
						});
						const mode = p.mode ?? "next";
						targetAgent.worker.postMessage({
							type: "message",
							fromAgentName,
							content: metaContent,
							mode,
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
					const created = await this.createAgent(fromAgentName, {
						name: p.name,
						cwd: p.cwd,
						model: p.model,
						roles: p.roles,
						includeTools: p.includeTools,
						excludeTools: p.excludeTools,
					});
					result = { agentName: created.agentName } satisfies CreateAgentResult;
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

				case "team": {
					const snapshot = this._registry.getTeamSnapshot();
					result = {
						...snapshot,
						executors: this._executorRegistry.list().map((executor) => ({
							...executor,
							boundAgentName: this._gateway.getBoundAgentName(executor.connectId),
						})),
					} satisfies TeamSnapshot;
					break;
				}

				case "set_source": {
					const p = params as {
						name: string;
						command: string;
						args?: string[];
						cwd?: string;
						env?: Record<string, string>;
						subscribers?: string[];
					};
					try {
						this._sourceManager.setSource(
							{
								name: p.name,
								command: p.command,
								args: p.args,
								cwd: p.cwd,
								env: p.env,
								subscribers: p.subscribers,
							},
							fromAgentName,
						);
						result = { ok: true } satisfies SetSourceResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies SetSourceResult;
					}
					break;
				}

				case "get_source": {
					const p = params as { name?: string };
					if (p.name) {
						const source = this._sourceManager.getSource(p.name);
						result = source
							? ({ source } satisfies GetSourceResult)
							: ({ error: `Source "${p.name}" not found` } satisfies GetSourceResult);
					} else {
						result = { sources: this._sourceManager.listSources() } satisfies GetSourceResult;
					}
					break;
				}

				case "delete_source": {
					const p = params as { name: string };
					try {
						this._sourceManager.deleteSource(p.name);
						result = { ok: true } satisfies DeleteSourceResult;
					} catch (err) {
						result = {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						} satisfies DeleteSourceResult;
					}
					break;
				}

				case "dispatch": {
					// Dispatch a tool to a connected executor by connect_id.
					// Used by dispatch_* tools when the caller provides connect_id.
					const p = params as { tool?: string; params?: unknown; connect_id?: string };
					if (!p.tool) {
						result = { ok: false, error: "tool is required" };
						break;
					}
					if (!p.connect_id) {
						result = { ok: false, error: "connect_id is required for dispatch" };
						break;
					}
					const cid = p.connect_id;
					const boundConnectId = this._gateway.getBinding(fromAgentName);
					if (!boundConnectId || boundConnectId !== cid) {
						result = {
							ok: false,
							error: `No d-pi client with connect_id "${p.connect_id}" is connected to agent "${fromAgentName}".`,
						};
						break;
					}
					const handle = this._executorRegistry.get(cid);
					if (!handle) {
						result = { ok: false, error: "Executor not available" };
						break;
					}
					if (!handle.sseConn) {
						result = { ok: false, error: "Executor not yet ready" };
						break;
					}
					// Generate a unique callId for the executor dispatch.
					// It only needs to be unique within the executor
					// registry's pendingCalls map; the original
					// HubChannel callId (passed in the `callId`
					// argument) is a separate namespace used by the
					// IPC layer to match the response back to the
					// awaiting worker.
					const executorCallId = `${fromAgentName}-dispatch-${randomUUID()}`;
					result = await new Promise<{ ok: true; result: unknown } | { ok: false; error: string }>((resolve) => {
						this._executorRegistry.addPendingCallback(cid, executorCallId, resolve);
						const timer = setTimeout(() => {
							const resolved = this._executorRegistry.resolveOne(cid, executorCallId, {
								ok: false,
								error: "Remote call timed out",
							});
							if (resolved) {
								process.stderr.write(
									`[hub] dispatch call ${executorCallId} timed out after ${this._remoteCallTimeoutMs}ms\n`,
								);
							}
						}, this._remoteCallTimeoutMs);
						this._executorRegistry.setPendingTimer(cid, executorCallId, timer);
						handle.sseConn!.send("remote-call", {
							callId: executorCallId,
							tool: p.tool,
							params: p.params,
						});
					});
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
