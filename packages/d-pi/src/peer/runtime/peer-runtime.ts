import { hostname } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	HUB_PROTOCOL_VERSION,
	type McpRuntimeStatus,
	type PeerConfigPayload,
	type PeerConfigSnapshot,
	type PeerHelloPayload,
	type SessionGetSkillsAck,
	type SourceRuntimeStatus,
	type ToolCallRequestPayload,
} from "../../hub/index.js";
import { SocketPeerClient, type SocketPeerClientOptions } from "../client/socket-client.js";
import { collectPeerConfigSnapshot } from "../config/peer-config-snapshot.js";
import { HUB_DEFAULT_AGENT_ID } from "../constants.js";
import { PeerMcpRuntime } from "../mcp/peer-mcp-runtime.js";
import { PeerSourceRuntime } from "../sources/peer-source-runtime.js";
import { PeerAppState } from "../state/peer-app-state.js";
import { PeerUiState } from "../state/peer-ui-state.js";
import { executePeerToolRequest } from "../tools/index.js";
import type { PeerThinkingLevel } from "../types.js";

export interface CreatePeerRuntimeOptions {
	hubUrl: string;
	/**
	 * Hub agent to bind; omit or leave undefined to use the hub default (typically `main`).
	 */
	agentId?: string;
	token?: string;
	peerId?: string;
	displayName?: string;
	version: string;
	executorEnabled?: boolean;
	tools?: string[];
	cwd?: string;
	agentDir?: string;
	onHandshakeLog?: SocketPeerClientOptions["onHandshakeLog"];
	onToolCallRequest?: SocketPeerClientOptions["onToolCallRequest"];
}

function isSourceResourceNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Source resourceId .* not found/i.test(message);
}

export class PeerRuntime {
	readonly appState = new PeerAppState();
	readonly uiState = new PeerUiState();
	readonly client: SocketPeerClient;
	readonly hello: PeerHelloPayload;
	private readonly peerMcpRuntime: PeerMcpRuntime;
	private readonly peerSourceRuntime: PeerSourceRuntime;
	private readonly configSnapshot: PeerConfigSnapshot;
	private readonly baseTools: string[];

	constructor(options: CreatePeerRuntimeOptions) {
		const cwd = options.cwd ?? process.cwd();
		const agentDir = options.agentDir ?? getAgentDir();
		const configSnapshot = collectPeerConfigSnapshot({ cwd, agentDir });
		this.configSnapshot = configSnapshot;
		const executorEnabled = options.executorEnabled !== false;
		this.baseTools = executorEnabled
			? (options.tools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"])
			: [];
		this.hello = {
			peerId: options.peerId ?? `${hostname()}-${process.pid}`,
			...(options.agentId !== undefined && options.agentId !== "" ? { agentId: options.agentId } : {}),
			token: options.token ?? "",
			protocolVersion: HUB_PROTOCOL_VERSION,
			displayName: options.displayName,
			version: options.version,
			platform: process.platform,
			hostname: hostname(),
			cwd,
			...(options.executorEnabled === false ? { executorEnabled: false } : {}),
		};
		this.peerMcpRuntime = new PeerMcpRuntime({
			cwd: this.hello.cwd ?? process.cwd(),
			snapshot: configSnapshot,
		});
		this.client = new SocketPeerClient({
			hubUrl: options.hubUrl,
			hello: this.hello,
			appState: this.appState,
			uiState: this.uiState,
			onHandshakeLog: options.onHandshakeLog,
			onToolCallRequest:
				options.onToolCallRequest ??
				(async (payload, socket) => {
					if (await this.peerMcpRuntime.executeToolRequest(this.hello.peerId, payload, socket)) {
						return;
					}
					await executePeerToolRequest(this.hello.cwd ?? process.cwd(), payload, socket);
				}),
		});
		this.peerSourceRuntime = new PeerSourceRuntime({
			cwd,
			agentDir,
			peerId: this.hello.peerId,
			isHubRunning: () => this.appState.getSnapshot().selectedAgent?.status.isRunning === true,
			targetAgentId: () => this.getBoundAgentId(),
			emitSourceMessage: async (sourceName, text, agentId) => {
				await this.client.sendSourceMessage({ sourceName, text, ...(agentId !== undefined ? { agentId } : {}) });
			},
		});
	}

	async start(): Promise<void> {
		const config: PeerConfigPayload = {
			configSnapshot: this.configSnapshot,
			tools: [],
		};
		let peerMcpStarted = false;
		try {
			if (this.hello.executorEnabled !== false) {
				await this.peerMcpRuntime.start();
				peerMcpStarted = true;
				config.mcpSnapshot = this.peerMcpRuntime.getSnapshot();
				config.tools = [...this.baseTools, ...this.peerMcpRuntime.getRemoteToolNames(this.hello.peerId)];
			}
			await this.client.connect();
			await this.client.uploadConfig(config);
			await this.client.waitForInitialSync();
			await this.peerSourceRuntime.start();
		} catch (error) {
			if (peerMcpStarted) {
				await this.peerMcpRuntime.stop().catch(() => {});
			}
			await this.client.disconnect().catch(() => {});
			throw error;
		}
	}

	async stop(): Promise<void> {
		await this.peerSourceRuntime.stop();
		await this.client.disconnect();
		await this.peerMcpRuntime.stop();
	}

	/**
	 * Effective hub agent for this peer: authoritative `hub:welcome.agentId` when connected,
	 * otherwise the `agentId` from `peer:hello` if set, or `root`.
	 */
	getBoundAgentId(): string {
		const fromWelcome = this.appState.getSnapshot().welcome?.agentId;
		if (fromWelcome !== undefined && fromWelcome !== "") {
			return fromWelcome;
		}
		if (this.hello.agentId !== undefined && this.hello.agentId.trim() !== "") {
			return this.hello.agentId.trim();
		}
		return HUB_DEFAULT_AGENT_ID;
	}

	async queueWrite(text: string): Promise<void> {
		await this.client.queueWrite(text);
	}

	async queueFlush(): Promise<void> {
		await this.client.queueFlush();
	}

	async abort(): Promise<void> {
		await this.client.abort();
	}

	async setModel(modelResourceId: string): Promise<void> {
		await this.client.setModel(modelResourceId);
	}

	async setThinkingLevel(level: PeerThinkingLevel): Promise<void> {
		await this.client.setThinkingLevel(level);
	}

	async invokeCommand(commandName: string, args?: string): Promise<void> {
		await this.client.invokeCommand(commandName, args);
	}

	async getSessionSources(): Promise<SourceRuntimeStatus[]> {
		return [...(await this.client.getSessionSources()), ...this.peerSourceRuntime.getStatuses()];
	}

	async pauseSource(resourceId: string): Promise<SourceRuntimeStatus[]> {
		let found = false;
		let notFoundError: unknown;
		try {
			await this.client.pauseSource(resourceId);
			found = true;
		} catch (error) {
			if (!isSourceResourceNotFoundError(error)) {
				throw error;
			}
			notFoundError = error;
		}
		for (const localResourceId of this.peerSourceRuntime.getMatchingLocalSourceResourceIds(resourceId)) {
			await this.peerSourceRuntime.pauseSource(localResourceId);
			found = true;
		}
		if (!found) {
			throw notFoundError instanceof Error ? notFoundError : new Error(`Source resourceId ${resourceId} not found`);
		}
		return this.getSessionSources();
	}

	async restartSource(resourceId: string): Promise<SourceRuntimeStatus[]> {
		let notFoundError: unknown;
		try {
			await this.client.restartSource(resourceId);
			return this.getSessionSources();
		} catch (error) {
			if (!isSourceResourceNotFoundError(error)) {
				throw error;
			}
			notFoundError = error;
		}
		const localResourceIds = this.peerSourceRuntime.getMatchingLocalSourceResourceIds(resourceId);
		if (localResourceIds.length === 0) {
			throw notFoundError instanceof Error ? notFoundError : new Error(`Source resourceId ${resourceId} not found`);
		}
		for (const localResourceId of localResourceIds) {
			await this.peerSourceRuntime.restartSource(localResourceId);
		}
		return this.getSessionSources();
	}

	async removeSource(resourceId: string): Promise<SourceRuntimeStatus[]> {
		if (this.peerSourceRuntime.hasLocalSourceResourceId(resourceId)) {
			await this.peerSourceRuntime.removeSource(resourceId);
			return this.getSessionSources();
		}
		return this.client.removeSource(resourceId);
	}

	async getMcpServers(): Promise<{ servers: McpRuntimeStatus[]; configError?: string }> {
		return this.client.getMcpServers();
	}

	async getSkills(): Promise<Extract<SessionGetSkillsAck, { ok: true }>> {
		return this.client.getSkills();
	}

	async pauseMcpServer(name: string): Promise<McpRuntimeStatus[]> {
		return this.client.pauseMcpServer(name);
	}

	async restartMcpServer(name: string): Promise<McpRuntimeStatus[]> {
		return this.client.restartMcpServer(name);
	}

	async removeMcpServer(name: string): Promise<McpRuntimeStatus[]> {
		return this.client.removeMcpServer(name);
	}

	retryConnection(): void {
		this.client.retryConnectionNow();
	}

	getStatus() {
		return {
			hello: this.hello,
			app: this.appState.getSnapshot(),
			ui: this.uiState.getSnapshot(),
		};
	}
}

export type { ToolCallRequestPayload };
