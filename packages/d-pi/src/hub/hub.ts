import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
	AgentNetworkSnapshot,
	CreateAgentResult,
	DestroyAgentResult,
	HubConfig,
	HubToWorkerMessage,
	SendMessageResult,
	WorkerToHubMessage,
} from "../types.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { HubGateway } from "./gateway.ts";

export class Hub {
	private readonly _registry: AgentRegistry;
	private readonly _gateway: HubGateway;
	private readonly _config: HubConfig;

	constructor(config: HubConfig) {
		this._config = config;
		const portStart = config.agentPortStart ?? 9091;
		this._registry = new AgentRegistry(portStart);
		this._gateway = new HubGateway(
			this._registry,
			(parentId, options) => this.createAgent(parentId, options),
			(agentId) => this.destroyAgent(agentId),
		);
	}

	async start(): Promise<void> {
		const hubPort = this._config.port ?? 9090;

		// 1. Start gateway
		await this._gateway.start(hubPort);

		// 2. Create root agent
		await this.createAgent(undefined, {
			name: "root",
			model: this._config.model,
		});

		process.stderr.write(`[d-pi hub] Workspace: ${this._config.workspaceRoot}\n`);
		process.stderr.write(`[d-pi hub] Listening on port ${hubPort}\n`);
		process.stderr.write(`[d-pi hub] Connect with: d-pi connect --url http://localhost:${hubPort}\n`);
	}

	async createAgent(
		parentAgentId: string | undefined,
		options: { name: string; cwd?: string; model?: string },
	): Promise<CreateAgentResult> {
		const agentId = crypto.randomUUID();
		const port = await this._registry.allocatePort();

		// Agent cwd: workspaceRoot/agents/<name>/ (create if needed)
		const agentDir = options.cwd ?? join(this._config.workspaceRoot, "agents", options.name);
		mkdirSync(agentDir, { recursive: true });

		// Create worker
		const worker = new Worker(new URL("../worker/agent-worker.js", import.meta.url), {
			workerData: {
				agentId,
				port,
				cwd: agentDir,
				model: options.model,
				parentAgentId,
				agentName: options.name,
				workspaceContext: this._config.workspaceContext,
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
				reject(new Error(`Worker ${agentId} startup timeout`));
			}, 120_000);

			const readyHandler = (message: WorkerToHubMessage) => {
				if (message.type === "ready" && message.agentId === agentId) {
					clearTimeout(timeout);
					this._registry.updateStatus(agentId, "ready");
					worker.off("message", readyHandler);
					resolve({ agentId, name: options.name });
				}
				if (message.type === "error" && message.agentId === agentId) {
					clearTimeout(timeout);
					worker.off("message", readyHandler);
					reject(new Error(message.error));
				}
			};
			worker.on("message", readyHandler);
		});
	}

	async destroyAgent(agentId: string): Promise<void> {
		const record = this._registry.get(agentId);
		if (!record) {
			throw new Error(`Agent not found: ${agentId}`);
		}

		// Collect all workers to terminate before unregister removes them from registry
		const destroyedIds = this._registry.getDescendants(agentId);
		destroyedIds.push(agentId);

		const workersToTerminate: Array<{ id: string; worker: Worker }> = [];
		for (const id of destroyedIds) {
			const r = this._registry.get(id);
			if (r) {
				workersToTerminate.push({ id, worker: r.worker });
			}
		}

		// Unregister cascades to descendants
		this._registry.unregister(agentId);

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
		if (!agent) return;

		try {
			let result: unknown;

			switch (tool) {
				case "send_message": {
					const p = params as { agent_id: string; message: string };
					const targetAgent = this._registry.get(p.agent_id);
					if (!targetAgent) {
						result = { ok: false, error: `Agent not found: ${p.agent_id}` } satisfies SendMessageResult;
					} else {
						targetAgent.worker.postMessage({
							type: "message",
							fromAgentId,
							content: p.message,
						} satisfies HubToWorkerMessage);
						result = { ok: true } satisfies SendMessageResult;
					}
					break;
				}

				case "create_agent": {
					const p = params as { name: string; cwd?: string; model?: string };
					const created = await this.createAgent(fromAgentId, {
						name: p.name,
						cwd: p.cwd,
						model: p.model,
					});
					result = { agentId: created.agentId, name: created.name } satisfies CreateAgentResult;
					break;
				}

				case "destroy_agent": {
					const p = params as { agent_id: string };
					await this.destroyAgent(p.agent_id);
					result = { ok: true } satisfies DestroyAgentResult;
					break;
				}

				case "agent_network": {
					result = this._registry.getSnapshot() satisfies AgentNetworkSnapshot;
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
