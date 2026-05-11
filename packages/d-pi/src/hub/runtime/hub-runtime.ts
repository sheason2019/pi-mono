import { existsSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { VERSION } from "../../version.js";
import { HubAgentAdapter } from "../agent/hub-agent-adapter.js";
import type { CreateHubAgentAdapterOptions } from "../agent/types.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import {
	getChildAgentDir,
	getChildAgentMcpConfigPath,
	getChildAgentSourcesConfigPath,
	initializeChildAgentDirectory,
} from "../agents/child-agent-layout.js";
import type {
	ChildAgentToolHost,
	CreateChildToolInput,
	CreateTemporaryChildToolInput,
	ForkChildToolInput,
	ReadAgentHistoryToolInput,
	RemoveChildToolInput,
	RenameChildToolInput,
	SpawnChildToolInput,
	StartChildToolInput,
	StopChildToolInput,
	UpdateChildToolInput,
} from "../agents/child-agent-tools.js";
import type { GroupToolHost, UpdateAgentDescriptionToolInput } from "../agents/group-tools.js";
import { HubAgentRuntime } from "../agents/hub-agent-runtime.js";
import type { AgentExecutorConfig, AgentRecord } from "../agents/types.js";
import { ROOT_AGENT_ID } from "../agents/types.js";
import { HubAuthTokenStore } from "../auth/token-store.js";
import type { AgentTokenToolHost, CreateAgentTokenToolInput, RevokeAgentTokenToolInput } from "../auth/token-tools.js";
import { getListenHost, getListenPort } from "../config.js";
import { ConfigLayerRegistry } from "../config-aggregation/config-layer-registry.js";
import { buildAgentConfigLayers } from "../config-aggregation/local-config-layers.js";
import { mergeConfigLayers } from "../config-aggregation/merge-config.js";
import type { PeerConfigSnapshot } from "../config-aggregation/types.js";
import {
	type NodeContainerExecutorHandle,
	NodeContainerExecutorLauncher,
	type SpawnProcess,
} from "../executors/container-executor.js";
import type { McpClientHandle } from "../mcp/mcp-client.js";
import { McpHost } from "../mcp/mcp-host.js";
import type { McpServerConfig } from "../mcp/types.js";
import { PeerRegistry } from "../peers/peer-registry.js";
import type { RegisteredPeer } from "../peers/peer-types.js";
import { HubSessionService } from "../session/hub-session-service.js";
import type { HubSessionEvent } from "../session/session-events.js";
import { loadChildSourcesConfigFromPath, loadSourcesConfigForAgents } from "../sources/source-config.js";
import { SourceHost } from "../sources/source-host.js";
import { createHostPeerRecord } from "../tools/host-peer.js";
import type { PeerToolBridge } from "../tools/peer-tool-bridge.js";
import { HUB_PROTOCOL_VERSION, type PublicOrgSnapshot } from "../transport/protocol.js";
import { SocketHubServer, type SocketHubServerAddress } from "../transport/socket-hub-server.js";
import type { HubLogDetails, HubLogSink } from "../tui/hub-log.js";
import { assertWorkspaceInitialized } from "../workspace.js";

export interface StartHubRuntimeOptions {
	host?: string;
	port?: number;
}

/**
 * Test-only and advanced wiring for hub bootstrap.
 * Production `HubRuntime.open(cwd)` leaves `mcp` unset; tests may inject
 * a fake `createClient` to avoid real MCP processes.
 */
export interface HubRuntimeOpenOptions {
	mcp?: {
		createClient?: (config: McpServerConfig, opts: { timeoutMs: number }) => Promise<McpClientHandle>;
	};
	executors?: {
		containerSpawn?: SpawnProcess;
	};
	logs?: HubLogSink;
}

type InitializeAdapterOptions = Omit<CreateHubAgentAdapterOptions, "sessionService" | "tools" | "cwd">;
type CreateMcpClient = NonNullable<HubRuntimeOpenOptions["mcp"]>["createClient"];
type PendingPeerConfigChange = { type: "set"; snapshot: PeerConfigSnapshot } | { type: "remove" };
type ChildResourceExtends = SpawnChildToolInput["extends"];
type AgentHydrationStatus = "running" | "loading" | "not_hydrated" | "error";

export class HubRuntime implements ChildAgentToolHost, GroupToolHost, AgentTokenToolHost {
	readonly cwd: string;
	readonly agentRegistry: AgentRegistry;
	readonly authTokenStore: HubAuthTokenStore;
	readonly sourceHost: SourceHost;
	readonly mcpHost: McpHost;
	readonly rootTokenForDisplay: string | undefined;

	private readonly socketServer: SocketHubServer;
	private readonly agentRuntimes = new Map<string, HubAgentRuntime>();
	private readonly configLayers = new ConfigLayerRegistry();
	private readonly adapterUserOptions: { current: InitializeAdapterOptions };
	private liveEventUnsubs: Array<{ agentId: string; unsubscribe: () => void }> = [];
	private readonly createMcpClient: CreateMcpClient | undefined;
	private readonly logs: HubLogSink | undefined;
	private readonly containerExecutorLauncher: NodeContainerExecutorLauncher;
	private readonly containerExecutorHandles = new Map<string, NodeContainerExecutorHandle>();
	private socketAddress: SocketHubServerAddress | undefined;
	private readonly pendingPeerConfigChangesByAgentId = new Map<string, Map<string, PendingPeerConfigChange>>();
	private readonly peerConfigApplyInFlightByAgentId = new Map<string, Promise<boolean>>();
	private readonly sessionLogUnsubs = new Map<string, () => void>();
	private readonly temporaryCleanupUnsubs = new Map<string, () => void>();
	private readonly temporaryCleanupInFlight = new Set<string>();
	private readonly childStartInFlightByAgentId = new Map<string, Promise<HubAgentRuntime>>();
	private readonly childStartErrorsByAgentId = new Map<string, string>();
	private readonly manuallyStoppedAgentIds = new Set<string>();
	private backgroundChildHydrationStarted = false;
	private stopping = false;
	private sessionFanout: Array<{
		listener: (agentId: string, event: HubSessionEvent) => void;
		subscriptions: Array<{ agentId: string; unsubscribe: () => void }>;
	}> = [];

	private constructor(
		cwd: string,
		agentRegistry: AgentRegistry,
		authTokenStore: HubAuthTokenStore,
		rootTokenForDisplay: string | undefined,
		socketServer: SocketHubServer,
		sourceHost: SourceHost,
		mcpHost: McpHost,
		adapterUserOptions: { current: InitializeAdapterOptions },
		rootRuntime: HubAgentRuntime,
		createMcpClient: CreateMcpClient | undefined,
		logs: HubLogSink | undefined,
		containerExecutorLauncher: NodeContainerExecutorLauncher,
	) {
		this.cwd = cwd;
		this.agentRegistry = agentRegistry;
		this.authTokenStore = authTokenStore;
		this.rootTokenForDisplay = rootTokenForDisplay;
		this.socketServer = socketServer;
		this.sourceHost = sourceHost;
		this.mcpHost = mcpHost;
		this.adapterUserOptions = adapterUserOptions;
		this.createMcpClient = createMcpClient;
		this.logs = logs;
		this.containerExecutorLauncher = containerExecutorLauncher;
		this.agentRuntimes.set(ROOT_AGENT_ID, rootRuntime);
	}

	private log(level: keyof HubLogSink, message: string, details?: string | HubLogDetails): void {
		try {
			this.logs?.[level](message, details);
		} catch {
			// Logging is best-effort and must not affect runtime lifecycle.
		}
	}

	get sessionService(): HubSessionService {
		return this.getRootAgentRuntime().sessionService;
	}

	get peerRegistry(): PeerRegistry {
		return this.getRootAgentRuntime().peerRegistry;
	}

	get tools(): ToolDefinition[] {
		return this.getRootAgentRuntime().tools;
	}

	get peerToolBridge(): PeerToolBridge {
		return this.getRootAgentRuntime().peerToolBridge;
	}

	get agentAdapter(): HubAgentAdapter | undefined {
		return this.getRootAgentRuntime().agentAdapter;
	}

	set agentAdapter(value: HubAgentAdapter | undefined) {
		this.getRootAgentRuntime().agentAdapter = value;
	}

	getAgentRecords(): AgentRecord[] {
		return this.agentRegistry.getAll();
	}

	getRootAgentRuntime(): HubAgentRuntime {
		return this.getAgentRuntime(ROOT_AGENT_ID);
	}

	getAgentRuntime(agentId: string = ROOT_AGENT_ID): HubAgentRuntime {
		const rt = this.agentRuntimes.get(agentId);
		if (!rt) {
			throw new Error(`Unknown agent id: ${agentId}`);
		}
		return rt;
	}

	tryGetAgentRuntime(agentId: string): HubAgentRuntime | undefined {
		return this.agentRuntimes.get(agentId);
	}

	getAgentHydrationStatus(agentId: string): AgentHydrationStatus {
		if (agentId === ROOT_AGENT_ID) {
			return this.getRootAgentRuntime().agentAdapter ? "running" : "loading";
		}
		if (this.childStartInFlightByAgentId.has(agentId)) {
			return "loading";
		}
		if (this.childStartErrorsByAgentId.has(agentId)) {
			return "error";
		}
		const runtime = this.agentRuntimes.get(agentId);
		return runtime?.agentAdapter ? "running" : "not_hydrated";
	}

	getPublicOrgSnapshot(): PublicOrgSnapshot {
		return {
			app: "d-pi hub",
			version: VERSION,
			protocolVersion: HUB_PROTOCOL_VERSION,
			generatedAt: new Date().toISOString(),
			agents: this.getAgentRecords().map((record) => {
				const runtime = this.tryGetAgentRuntime(record.id);
				const snapshot = runtime?.sessionService.getSnapshot();
				const activationStatus = this.getAgentHydrationStatus(record.id);
				return {
					id: record.id,
					...(record.parentId === undefined ? {} : { parentId: record.parentId }),
					kind: record.kind,
					lifecycle: record.lifecycle,
					...(record.name === undefined ? {} : { name: record.name }),
					activationStatus,
					isRunning: snapshot?.isRunning ?? false,
					peerCount: runtime?.peerRegistry.size() ?? 0,
					hasError: activationStatus === "error" || Boolean(snapshot?.lastError),
				};
			}),
		};
	}

	isAgentInSubtree(scopeRootAgentId: string, targetAgentId: string): boolean {
		return this.agentRegistry.isInSubtree(scopeRootAgentId, targetAgentId);
	}

	/** Ids of all known agents. Child runtimes may hydrate lazily on first use. */
	getAllMessagingAgentIds(): string[] {
		return this.agentRegistry
			.getAll()
			.map((record) => record.id)
			.filter((agentId) => agentId === ROOT_AGENT_ID || !this.manuallyStoppedAgentIds.has(agentId));
	}

	/**
	 * Subscribes to `HubSessionService` activity for every running agent, forwarding `(agentId, event)` until unsubscribed.
	 * New agents added after `SocketHubServer.start()` are wired automatically.
	 */
	subscribeAllSessionServiceEvents(listener: (agentId: string, event: HubSessionEvent) => void): () => void {
		const subscriptions: Array<{ agentId: string; unsubscribe: () => void }> = [];
		for (const [agentId, rt] of this.agentRuntimes) {
			subscriptions.push({
				agentId,
				unsubscribe: rt.sessionService.subscribe((event) => {
					listener(agentId, event);
				}),
			});
		}
		const rec = { listener, subscriptions };
		this.sessionFanout.push(rec);
		return () => {
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
			const i = this.sessionFanout.indexOf(rec);
			if (i >= 0) {
				this.sessionFanout.splice(i, 1);
			}
		};
	}

	static open(cwd: string = process.cwd(), openOptions: HubRuntimeOpenOptions = {}): HubRuntime {
		const agentRegistry = AgentRegistry.open(cwd);
		const authTokenStore = HubAuthTokenStore.open(cwd);
		const rootToken = authTokenStore.ensureRootToken().token;
		const rootRecord = agentRegistry.require(ROOT_AGENT_ID);
		const rootSession = HubSessionService.openAgent(cwd, rootRecord.sessionFile);
		const rootPeerRegistry = new PeerRegistry();

		const hubRef: { v?: HubRuntime } = {};
		const sourceHost = new SourceHost({
			cwd,
			loadSources: () =>
				loadSourcesConfigForAgents(
					cwd,
					agentRegistry
						.getAll()
						.filter((record) => record.kind === "child")
						.map((record) => record.id),
				),
			logs: openOptions.logs,
			inbound: {
				submitFromSource: async (sourceName, agentId, text) => {
					const hub = hubRef.v;
					if (!hub) {
						throw new Error("HubRuntime is not ready");
					}
					const rt = await hub.ensureAgentStarted(agentId, "source");
					if (!rt) {
						throw new Error(`Unknown agent id: ${JSON.stringify(agentId)}`);
					}
					const adapter = rt.agentAdapter;
					if (!adapter) {
						throw new Error("Hub agent adapter is not initialized");
					}
					await adapter.enqueueFromSource(sourceName, text);
				},
			},
		});
		/** Assigned immediately after; socket handlers only run once clients connect. */
		let mcpHost!: McpHost;
		const adapterUserOptions: { current: InitializeAdapterOptions } = { current: {} };
		const socketServer = new SocketHubServer({
			getDefaultAgentId: () => ROOT_AGENT_ID,
			getAgentIds: () => agentRegistry.getAll().map((record) => record.id),
			getAgentRuntime: (agentId) => hubRef.v?.tryGetAgentRuntime(agentId),
			ensureAgentStarted: (agentId) => hubRef.v?.ensureAgentStarted(agentId, "socket") ?? Promise.resolve(undefined),
			getAgentMetadata: (agentId) => {
				const record = agentRegistry.get(agentId);
				return record
					? {
							parentId: record.parentId,
							kind: record.kind,
							lifecycle: record.lifecycle,
							name: record.name,
							description: record.description,
						}
					: undefined;
			},
			getPublicOrgSnapshot: () => hubRef.v!.getPublicOrgSnapshot(),
			authenticateToken: (token) => authTokenStore.authenticate(token),
			isAgentInScope: (scopeRootAgentId, targetAgentId) =>
				agentRegistry.isInSubtree(scopeRootAgentId, targetAgentId),
			getHttpSessionService: () => hubRef.v!.getRootAgentRuntime().sessionService,
			subscribeAllAgentSessionEvents: (onEvent) => {
				const h = hubRef.v;
				if (!h) {
					return () => {};
				}
				return h.subscribeAllSessionServiceEvents((agentId, event) => onEvent(agentId, event));
			},
			getSourceStatuses: (agentId) => hubRef.v?.getSourceStatusesForAgent(agentId) ?? [],
			getSourceMessageTargetAgentIds: (boundAgentId, sourceName, requestedAgentId) =>
				hubRef.v?.getSourceMessageTargetAgentIds(boundAgentId, sourceName, requestedAgentId) ?? [
					requestedAgentId ?? boundAgentId,
				],
			sourceMutators: {
				pause: (resourceId) => sourceHost.pauseSource(resourceId),
				restart: (resourceId) => sourceHost.restartSource(resourceId),
				remove: (resourceId) => sourceHost.removeSource(resourceId),
			},
			getMcpServerStatuses: (agentId) => hubRef.v?.getMcpServerStatusesForAgent(agentId) ?? [],
			getMcpConfigError: (agentId) => hubRef.v?.getMcpHostForAgent(agentId)?.getConfigError(),
			onPeerConfigSnapshot: (agentId, peerId, snapshot) => {
				hubRef.v?.setPeerConfigSnapshot(agentId, peerId, snapshot);
			},
			onPeerConfigRemoved: (agentId, peerId) => {
				hubRef.v?.removePeerConfigSnapshot(agentId, peerId);
			},
			mcpMutators: {
				pauseServer: async (agentId, name) => {
					const host = hubRef.v?.getMcpHostForAgent(agentId);
					return host ? host.pauseServer(name) : { ok: false, error: `Unknown agent id: ${agentId}` };
				},
				restartServer: async (agentId, name) => {
					const host = hubRef.v?.getMcpHostForAgent(agentId);
					return host ? host.restartServer(name) : { ok: false, error: `Unknown agent id: ${agentId}` };
				},
				removeServer: async (agentId, name) => {
					const host = hubRef.v?.getMcpHostForAgent(agentId);
					return host ? host.removeServer(name) : { ok: false, error: `Unknown agent id: ${agentId}` };
				},
			},
			logs: openOptions.logs,
		});
		const rootRuntime = new HubAgentRuntime({
			cwd,
			record: rootRecord,
			sessionService: rootSession,
			socketServer,
			peerRegistry: rootPeerRegistry,
			logs: openOptions.logs,
			resolvePeerForTool: (callerAgentId, peerId) => hubRef.v?.resolvePeerForTool(callerAgentId, peerId),
			beforeInputQueueDrain: () => hubRef.v?.applyPendingPeerConfigBeforeInput(ROOT_AGENT_ID),
			refreshSources: async () => {
				await sourceHost.start();
			},
			refreshMcp: async () => {
				await mcpHost.start();
			},
			createAgentAdapter: (base) => {
				const hub = hubRef.v;
				if (!hub) {
					throw new Error("HubRuntime is not ready");
				}
				// `base` from HubAgentRuntime may include explicit `model: undefined` / `services: undefined` which
				// must not win over `initializeAgentAdapter` options. Apply user options after `base`, then
				// re-pin hub-wired services.
				return HubAgentAdapter.create({
					...base,
					...adapterUserOptions.current,
					cwd: hub.cwd,
					configLayers: hub.buildConfigLayersForAgent(ROOT_AGENT_ID, undefined),
					getConfigLayers: () => hub.buildConfigLayersForAgent(ROOT_AGENT_ID, undefined),
					sessionService: base.sessionService,
					tools: base.tools,
					refreshSources: async () => {
						await hub.sourceHost.start();
					},
					refreshMcp: async () => {
						await hub.mcpHost.start();
					},
					beforeInputQueueDrain: () => hub.applyPendingPeerConfigBeforeInput(ROOT_AGENT_ID),
					logs: hub.logs,
				});
			},
			getChildAgentHost: () => {
				const hub = hubRef.v;
				if (!hub) {
					throw new Error("HubRuntime is not ready");
				}
				return hub;
			},
			getAgentMessagingHost: () => {
				const hub = hubRef.v;
				if (!hub) {
					throw new Error("HubRuntime is not ready");
				}
				return hub;
			},
			getGroupHost: () => {
				const hub = hubRef.v;
				if (!hub) {
					throw new Error("HubRuntime is not ready");
				}
				return hub;
			},
			getAgentTokenHost: () => {
				const hub = hubRef.v;
				if (!hub) {
					throw new Error("HubRuntime is not ready");
				}
				return hub;
			},
		});
		mcpHost = new McpHost({
			cwd,
			customTools: rootRuntime.tools,
			configRoot: () => mergeConfigLayers(hubRef.v?.buildConfigLayersForAgent(ROOT_AGENT_ID, undefined) ?? []).mcp,
			createClient: openOptions.mcp?.createClient,
			...(openOptions.logs === undefined ? {} : { logs: openOptions.logs }),
		});
		const runtime = new HubRuntime(
			cwd,
			agentRegistry,
			authTokenStore,
			rootToken,
			socketServer,
			sourceHost,
			mcpHost,
			adapterUserOptions,
			rootRuntime,
			openOptions.mcp?.createClient,
			openOptions.logs,
			new NodeContainerExecutorLauncher({ spawn: openOptions.executors?.containerSpawn }),
		);
		hubRef.v = runtime;
		runtime.wireSessionLogForAgent(ROOT_AGENT_ID, rootRuntime);
		return runtime;
	}

	getMcpHostForAgent(agentId: string): McpHost | undefined {
		if (agentId === ROOT_AGENT_ID) {
			return this.mcpHost;
		}
		return this.tryGetAgentRuntime(agentId)?.mcpHost;
	}

	getMcpServerStatusesForAgent(agentId: string) {
		const runtime = this.tryGetAgentRuntime(agentId);
		const local = this.getMcpHostForAgent(agentId)?.getStatuses() ?? [];
		const remote =
			runtime?.peerRegistry.list().flatMap((peer) =>
				(peer.mcpSnapshot?.servers ?? []).map((server) => ({
					...server,
				})),
			) ?? [];
		return [...local, ...remote];
	}

	private resolvePeerForTool(callerAgentId: string, peerId: string): RegisteredPeer | undefined {
		for (const record of this.agentRegistry.getAll()) {
			if (!this.agentRegistry.isInSubtree(callerAgentId, record.id)) {
				continue;
			}
			const peer = this.tryGetAgentRuntime(record.id)?.peerRegistry.get(peerId);
			if (peer?.executorEnabled) {
				return peer;
			}
		}
		return undefined;
	}

	private getVisibleExecutorPeersForAgent(callerAgentId: string): RegisteredPeer[] {
		const peers: RegisteredPeer[] = [];
		for (const record of this.agentRegistry.getAll()) {
			if (!this.agentRegistry.isInSubtree(callerAgentId, record.id)) {
				continue;
			}
			for (const peer of this.tryGetAgentRuntime(record.id)?.peerRegistry.list() ?? []) {
				if (peer.executorEnabled) {
					peers.push(peer);
				}
			}
		}
		return peers;
	}

	getSourceStatusesForAgent(agentId: string) {
		return this.sourceHost.getStatuses().filter((status) => status.agentId === agentId);
	}

	private getSourceMessageTargetAgentIds(
		boundAgentId: string,
		sourceName: string,
		requestedAgentId: string | undefined,
	): string[] {
		if (requestedAgentId !== undefined) {
			return [requestedAgentId];
		}
		const targets = [boundAgentId];
		if (boundAgentId !== ROOT_AGENT_ID) {
			return targets;
		}
		for (const record of this.agentRegistry.getAll()) {
			if (record.kind !== "child") {
				continue;
			}
			const childConfig = loadChildSourcesConfigFromPath(getChildAgentSourcesConfigPath(this.cwd, record.id));
			const selection = childConfig.extends?.host?.sources;
			if (selection === true || (Array.isArray(selection) && selection.includes(sourceName))) {
				targets.push(record.id);
			}
		}
		return targets;
	}

	private buildConfigLayersForAgent(
		agentId: string,
		agentDir: string | undefined,
	): ReturnType<typeof buildAgentConfigLayers> {
		return buildAgentConfigLayers({
			cwd: this.cwd,
			agentDir,
			peerSnapshots: this.configLayers.listPeerSnapshots(agentId),
		});
	}

	private refreshAgentListViews(): void {
		this.socketServer.refreshAgentListViews();
	}

	private setPeerConfigSnapshot(agentId: string, peerId: string, snapshot: PeerConfigSnapshot): void {
		this.queuePeerConfigChange(agentId, peerId, { type: "set", snapshot });
		void this.applyPendingPeerConfigForAgent(agentId);
	}

	private removePeerConfigSnapshot(agentId: string, peerId: string): void {
		this.queuePeerConfigChange(agentId, peerId, { type: "remove" });
		void this.applyPendingPeerConfigForAgent(agentId);
	}

	private queuePeerConfigChange(agentId: string, peerId: string, change: PendingPeerConfigChange): void {
		let pending = this.pendingPeerConfigChangesByAgentId.get(agentId);
		if (!pending) {
			pending = new Map();
			this.pendingPeerConfigChangesByAgentId.set(agentId, pending);
		}
		pending.set(peerId, change);
	}

	private async applyPendingPeerConfigBeforeInput(agentId: string): Promise<boolean> {
		const applied = await this.applyPendingPeerConfigForAgent(agentId);
		return !applied;
	}

	private async applyPendingPeerConfigForAgent(agentId: string): Promise<boolean> {
		const inFlight = this.peerConfigApplyInFlightByAgentId.get(agentId);
		if (inFlight) {
			await inFlight;
			return true;
		}
		const apply = this.applyPendingPeerConfigForAgentOnce(agentId);
		this.peerConfigApplyInFlightByAgentId.set(agentId, apply);
		try {
			return await apply;
		} finally {
			if (this.peerConfigApplyInFlightByAgentId.get(agentId) === apply) {
				this.peerConfigApplyInFlightByAgentId.delete(agentId);
			}
		}
	}

	private async applyPendingPeerConfigForAgentOnce(agentId: string): Promise<boolean> {
		const runtime = this.tryGetAgentRuntime(agentId);
		if (!runtime || runtime.sessionService.getSnapshot().isRunning) {
			return false;
		}
		const pending = this.pendingPeerConfigChangesByAgentId.get(agentId);
		if (!pending || pending.size === 0) {
			return false;
		}
		this.pendingPeerConfigChangesByAgentId.delete(agentId);
		for (const [peerId, change] of pending) {
			if (change.type === "remove") {
				this.configLayers.removePeerSnapshot(agentId, peerId);
			} else {
				this.configLayers.setPeerSnapshot(agentId, peerId, change.snapshot);
			}
		}
		await runtime.restartAdapter();
		runtime.agentAdapter?.requestInputQueuePump?.();
		return true;
	}

	async initializeAgentAdapter(options: InitializeAdapterOptions = {}): Promise<HubAgentAdapter> {
		const main = this.getRootAgentRuntime();
		if (main.agentAdapter) {
			return main.agentAdapter;
		}

		this.adapterUserOptions.current = options;

		let mainStartCompleted = false;
		let mainStartAttempted = false;

		try {
			const mcpStartedAt = Date.now();
			await this.mcpHost.start();
			this.log("info", "hub startup timing", {
				phase: "root_mcp",
				agentId: ROOT_AGENT_ID,
				durationMs: Date.now() - mcpStartedAt,
			});

			mainStartAttempted = true;
			const rootStartedAt = Date.now();
			await main.start();
			mainStartCompleted = true;
			this.log("info", "hub startup timing", {
				phase: "root_agent_start",
				agentId: ROOT_AGENT_ID,
				durationMs: Date.now() - rootStartedAt,
			});
			this.wireLiveEventsForAgent(ROOT_AGENT_ID, main);

			const adapter = main.agentAdapter;
			if (!adapter) {
				throw new Error("Hub agent adapter is not initialized");
			}
			return adapter;
		} catch (e) {
			if (mainStartAttempted && !mainStartCompleted) {
				await main.stop();
			}
			throw e;
		}
	}

	private createChildHubAgentRuntime(rec: AgentRecord): HubAgentRuntime {
		const childSession = HubSessionService.openAgent(this.cwd, rec.sessionFile);
		return new HubAgentRuntime({
			cwd: this.cwd,
			agentDir: getChildAgentDir(this.cwd, rec.id),
			getConfigLayers: () => this.buildConfigLayersForAgent(rec.id, getChildAgentDir(this.cwd, rec.id)),
			record: rec,
			sessionService: childSession,
			socketServer: this.socketServer,
			mcp: {
				configPath: getChildAgentMcpConfigPath(this.cwd, rec.id),
				configRoot: () =>
					mergeConfigLayers(this.buildConfigLayersForAgent(rec.id, getChildAgentDir(this.cwd, rec.id))).mcp,
				createClient: this.createMcpClient,
			},
			logs: this.logs,
			resolvePeerForTool: (callerAgentId, peerId) => this.resolvePeerForTool(callerAgentId, peerId),
			beforeInputQueueDrain: () => this.applyPendingPeerConfigBeforeInput(rec.id),
			refreshSources: async () => {
				await this.sourceHost.start();
			},
			getChildAgentHost: () => this,
			getAgentMessagingHost: () => this,
			getGroupHost: () => this,
			getAgentTokenHost: () => this,
		});
	}

	private ensureAgentRuntimeRegistered(agentId: string): HubAgentRuntime | undefined {
		const existing = this.agentRuntimes.get(agentId);
		if (existing) {
			return existing;
		}
		const record = this.agentRegistry.get(agentId);
		if (!record || record.kind !== "child") {
			return undefined;
		}
		const startedAt = Date.now();
		const child = this.createChildHubAgentRuntime(record);
		this.agentRuntimes.set(record.id, child);
		this.wireSessionLogForAgent(record.id, child);
		this.wireSessionFanoutForNewAgent(record.id, child);
		this.wireLiveEventsForAgent(record.id, child);
		this.log("info", "hub startup timing", {
			phase: "child_session_open",
			agentId: record.id,
			durationMs: Date.now() - startedAt,
		});
		return child;
	}

	async ensureAgentStarted(agentId: string, reason: string = "on_demand"): Promise<HubAgentRuntime | undefined> {
		if (agentId === ROOT_AGENT_ID) {
			const root = this.getRootAgentRuntime();
			if (!root.agentAdapter) {
				await root.start();
			}
			return root;
		}
		if (this.manuallyStoppedAgentIds.has(agentId) && reason !== "explicit_start" && reason !== "tool_start") {
			return undefined;
		}
		const existingInFlight = this.childStartInFlightByAgentId.get(agentId);
		if (existingInFlight) {
			return existingInFlight;
		}
		const child = this.ensureAgentRuntimeRegistered(agentId);
		if (!child) {
			return undefined;
		}
		if (child.agentAdapter) {
			return child;
		}
		const startPromise = (async () => {
			const startedAt = Date.now();
			this.childStartErrorsByAgentId.delete(agentId);
			this.log("info", "child agent hydration started", { agentId, reason });
			try {
				await child.start();
				this.maybeTrackTemporaryChild(child.record, child);
				await this.startContainerExecutorsForAgent(child.record);
				this.log("info", "child agent started", { agentId });
				this.log("info", "hub startup timing", {
					phase: "child_agent_start",
					agentId,
					durationMs: Date.now() - startedAt,
				});
				return child;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.childStartErrorsByAgentId.set(agentId, message);
				this.log("error", "child agent hydration failed", { agentId, reason, error: message });
				throw error;
			} finally {
				this.childStartInFlightByAgentId.delete(agentId);
			}
		})();
		this.childStartInFlightByAgentId.set(agentId, startPromise);
		return startPromise;
	}

	private wireSessionFanoutForNewAgent(agentId: string, rt: HubAgentRuntime): void {
		for (const e of this.sessionFanout) {
			e.subscriptions.push({
				agentId,
				unsubscribe: rt.sessionService.subscribe((ev) => {
					e.listener(agentId, ev);
				}),
			});
		}
	}

	private wireSessionLogForAgent(agentId: string, rt: HubAgentRuntime): void {
		if (!this.logs || this.sessionLogUnsubs.has(agentId)) {
			return;
		}
		const unsubscribe = rt.sessionService.subscribe((event) => {
			if (event.type === "error") {
				this.log("error", "agent error", { agentId, error: event.message });
			}
		});
		this.sessionLogUnsubs.set(agentId, unsubscribe);
	}

	private unwireSessionLogForAgent(agentId: string): void {
		const unsubscribe = this.sessionLogUnsubs.get(agentId);
		if (!unsubscribe) {
			return;
		}
		unsubscribe();
		this.sessionLogUnsubs.delete(agentId);
	}

	private wireLiveEventsForAgent(agentId: string, rt: HubAgentRuntime): void {
		if (this.liveEventUnsubs.some((entry) => entry.agentId === agentId)) {
			return;
		}
		this.liveEventUnsubs.push({
			agentId,
			unsubscribe: rt.subscribeLiveEvents((event) => {
				this.socketServer.broadcastLiveEvent(rt.record.id, event);
			}),
		});
	}

	private unwireSessionFanoutForAgent(agentId: string): void {
		for (const e of this.sessionFanout) {
			const keep: typeof e.subscriptions = [];
			for (const subscription of e.subscriptions) {
				if (subscription.agentId === agentId) {
					subscription.unsubscribe();
				} else {
					keep.push(subscription);
				}
			}
			e.subscriptions = keep;
		}
	}

	private unwireLiveEventsForAgent(agentId: string): void {
		const keep: typeof this.liveEventUnsubs = [];
		for (const entry of this.liveEventUnsubs) {
			if (entry.agentId === agentId) {
				entry.unsubscribe();
			} else {
				keep.push(entry);
			}
		}
		this.liveEventUnsubs = keep;
	}

	private static materializeSessionManagerToDisk(sm: SessionManager, path: string): void {
		if (existsSync(path)) {
			return;
		}
		const header = sm.getHeader();
		if (!header) {
			throw new Error("Session is missing a header.");
		}
		const content = [header, ...sm.getEntries()].map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(path, `${content}\n`, "utf8");
	}

	/**
	 * Test hook: how many `subscribeAllSessionServiceEvents` calls are still active (unsub not run).
	 * @internal
	 */
	getSessionFanoutEntryCountForTest(): number {
		return this.sessionFanout.length;
	}

	private assertAgentInSubtree(callerAgentId: string, targetAgentId: string, action: string): void {
		this.agentRegistry.require(callerAgentId);
		this.agentRegistry.require(targetAgentId);
		if (!this.agentRegistry.isInSubtree(callerAgentId, targetAgentId)) {
			throw new Error(`${action}: target agent "${targetAgentId}" is outside caller subtree "${callerAgentId}".`);
		}
	}

	/**
	 * After `agentRegistry` + session file are persisted, if adapter start fails, remove the registry row and
	 * session file so disk matches the in-memory runtime map.
	 */
	private rollbackPersistedChildRecordIfPresent(record: AgentRecord): void {
		if (this.agentRegistry.get(record.id) !== undefined) {
			this.agentRegistry.removeChild(record.id);
			this.agentRegistry.save();
		}
		HubRuntime.tryUnlinkFile(record.sessionFile);
	}

	private createPeerConnectCommand(agentId: string): string {
		const host = getListenHost();
		const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
		return `d-pi peer --hub http://${connectHost}:${getListenPort()} --agent ${agentId}`;
	}

	private static tryUnlinkFile(path: string): void {
		try {
			if (existsSync(path)) {
				unlinkSync(path);
			}
		} catch {
			// best-effort: cleanup after failed child ingest
		}
	}

	private continueChildCurrentTranscript(child: HubAgentRuntime): void {
		const adapter = child.agentAdapter as HubAgentRuntime["agentAdapter"] & {
			continueCurrentTranscript?: () => void;
		};
		if (!adapter) {
			throw new Error(`Child agent adapter is not initialized for ${child.record.id}.`);
		}
		adapter.continueCurrentTranscript?.();
	}

	private writeChildResourceExtendsConfig(agentId: string, ext: ChildResourceExtends): void {
		if (ext === undefined) {
			return;
		}
		if (ext.mcp !== undefined) {
			writeFileSync(
				getChildAgentMcpConfigPath(this.cwd, agentId),
				`${JSON.stringify({ extends: { host: { mcp: ext.mcp } }, servers: [] }, null, 2)}\n`,
				"utf8",
			);
		}
		if (ext.sources !== undefined) {
			writeFileSync(
				getChildAgentSourcesConfigPath(this.cwd, agentId),
				`${JSON.stringify({ extends: { host: { sources: ext.sources } }, sources: [] }, null, 2)}\n`,
				"utf8",
			);
		}
	}

	private async refreshSourcesForChildExtends(ext: ChildResourceExtends): Promise<void> {
		if (ext?.sources === undefined) {
			return;
		}
		await this.sourceHost.start();
	}

	private startBackgroundChildHydration(): void {
		if (this.backgroundChildHydrationStarted) {
			return;
		}
		this.backgroundChildHydrationStarted = true;
		const childRecords = this.agentRegistry.getAll().filter((record) => record.kind === "child");
		if (childRecords.length === 0) {
			return;
		}
		this.log("info", "child agent hydration queued", { agents: childRecords.length });
		setTimeout(() => {
			void this.hydrateChildAgentsInBackground(childRecords).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.log("error", "child agent hydration failed", { error: message });
			});
		}, 0);
	}

	private async hydrateChildAgentsInBackground(childRecords: AgentRecord[]): Promise<void> {
		const startedAt = Date.now();
		let started = 0;
		try {
			for (const record of childRecords) {
				if (this.stopping) {
					return;
				}
				if (!this.agentRegistry.get(record.id)) {
					continue;
				}
				try {
					const child = await this.ensureAgentStarted(record.id, "startup_background");
					if (child?.agentAdapter) {
						started += 1;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.log("error", "child agent hydration failed", {
						agentId: record.id,
						reason: "startup_background",
						error: message,
					});
				}
			}
		} finally {
			this.log("info", "hub startup timing", {
				phase: "child_background_hydration",
				durationMs: Date.now() - startedAt,
				agents: started,
			});
		}
	}

	private async startSourceHostAfterChildHydration(): Promise<void> {
		if (this.stopping) {
			return;
		}
		const startedAt = Date.now();
		await this.sourceHost.start();
		this.log("info", "hub startup timing", {
			phase: "sources_start",
			durationMs: Date.now() - startedAt,
			sources: this.sourceHost.getStatuses().length,
		});
	}

	/** Starts a new child `HubAgentRuntime` after a registry record and session file were created (used by tools). */
	private async addAndStartNewChildFromRegistry(record: AgentRecord): Promise<HubAgentRuntime> {
		const child = this.ensureAgentRuntimeRegistered(record.id);
		if (!child) {
			throw new Error(`Unknown child agent id: ${record.id}`);
		}
		try {
			const started = await this.ensureAgentStarted(record.id, "tool_start");
			if (!started) {
				throw new Error(`Unknown child agent id: ${record.id}`);
			}
			return started;
		} catch (e) {
			this.stopContainerExecutorsForAgent(record.id);
			this.unwireLiveEventsForAgent(record.id);
			this.unwireSessionFanoutForAgent(record.id);
			this.unwireSessionLogForAgent(record.id);
			this.agentRuntimes.delete(record.id);
			await child.stop();
			throw e;
		}
	}

	private containerExecutorKey(agentId: string, executorId: string): string {
		return `${agentId}:${executorId}`;
	}

	private getHubUrlForContainerExecutors(): string | undefined {
		const address = this.socketAddress;
		if (!address) {
			return undefined;
		}
		return `http://${address.host}:${address.port}`;
	}

	private async startContainerExecutorsForAgent(record: AgentRecord): Promise<void> {
		if (record.kind !== "child" || !record.executors?.length) {
			return;
		}
		const hubUrl = this.getHubUrlForContainerExecutors();
		if (!hubUrl) {
			return;
		}
		for (const executor of record.executors) {
			const key = this.containerExecutorKey(record.id, executor.id);
			if (this.containerExecutorHandles.has(key)) {
				continue;
			}
			const handle = this.containerExecutorLauncher.start({
				cwd: this.cwd,
				hubUrl,
				agentId: record.id,
				executor,
			});
			this.containerExecutorHandles.set(key, handle);
			this.log("info", "container executor started", { agentId: record.id, executorId: executor.id });
		}
	}

	private async startContainerExecutorsForRunningAgents(): Promise<void> {
		for (const record of this.agentRegistry.getAll()) {
			if (record.id !== ROOT_AGENT_ID && this.agentRuntimes.has(record.id)) {
				await this.startContainerExecutorsForAgent(record);
			}
		}
	}

	private stopContainerExecutorsForAgent(agentId: string): void {
		for (const [key, handle] of [...this.containerExecutorHandles.entries()]) {
			if (!key.startsWith(`${agentId}:`)) {
				continue;
			}
			handle.stop();
			this.containerExecutorHandles.delete(key);
		}
	}

	private stopAllContainerExecutors(): void {
		for (const [key, handle] of [...this.containerExecutorHandles.entries()]) {
			handle.stop();
			this.containerExecutorHandles.delete(key);
		}
	}

	private maybeTrackTemporaryChild(record: AgentRecord, child: HubAgentRuntime): void {
		if (record.lifecycle !== "temporary" || !record.parentId || this.temporaryCleanupUnsubs.has(record.id)) {
			return;
		}
		let sawRunning = false;
		const unsubscribe = child.sessionService.subscribe((event) => {
			if (event.type === "run_state_changed" && event.isRunning) {
				sawRunning = true;
				return;
			}
			if (!sawRunning) {
				return;
			}
			const snapshot = child.sessionService.getSnapshot();
			if (!snapshot.isRunning && (snapshot.queuedMessages?.length ?? 0) === 0) {
				void this.cleanupTemporaryChild(record.id);
			}
		});
		this.temporaryCleanupUnsubs.set(record.id, unsubscribe);
	}

	private async cleanupTemporaryChild(agentId: string): Promise<void> {
		if (this.temporaryCleanupInFlight.has(agentId)) {
			return;
		}
		this.temporaryCleanupInFlight.add(agentId);
		try {
			const record = this.agentRegistry.get(agentId);
			if (!record || record.lifecycle !== "temporary") {
				return;
			}
			if (record.reportResult !== false) {
				await this.reportTemporaryChildResult(record);
			}
			await this.removeChildAgentInternal(record.id, true);
		} finally {
			this.temporaryCleanupInFlight.delete(agentId);
		}
	}

	private async reportTemporaryChildResult(record: AgentRecord): Promise<void> {
		if (!record.parentId) {
			return;
		}
		const parent = this.tryGetAgentRuntime(record.parentId);
		const parentAdapter = parent?.agentAdapter;
		if (!parentAdapter) {
			return;
		}
		const result = this.extractLastAssistantText(record.id);
		if (!result) {
			return;
		}
		await parentAdapter.enqueueFromAgent(record.id, `Temporary child ${record.id} completed:\n\n${result}`);
	}

	private extractLastAssistantText(agentId: string): string | undefined {
		const rt = this.tryGetAgentRuntime(agentId);
		if (!rt) {
			return undefined;
		}
		const branch = rt.sessionService.getSessionManager().getBranch();
		for (const entry of [...branch].reverse()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const text = HubRuntime.messagePlainText(entry.message).trim();
				return text.length > 0 ? text : undefined;
			}
		}
		return undefined;
	}

	async createChildAgent(
		callerAgentIdOrInput: string | CreateChildToolInput,
		maybeInput?: CreateChildToolInput,
	): Promise<string> {
		const callerAgentId = typeof callerAgentIdOrInput === "string" ? callerAgentIdOrInput : ROOT_AGENT_ID;
		const input = typeof callerAgentIdOrInput === "string" ? maybeInput : callerAgentIdOrInput;
		if (!input) {
			throw new Error("create_child_agent: input is required.");
		}
		if (input.temporary === true) {
			if (input.mode !== "spawn") {
				throw new Error('create_child_agent: temporary=true supports only mode="spawn".');
			}
			if (input.background === undefined || input.background.trim().length === 0) {
				throw new Error('create_child_agent: "background" is required when temporary=true.');
			}
			return this.spawnChildAgent(callerAgentId, {
				name: input.name,
				description: input.description,
				background: input.background,
				extends: input.extends,
				temporary: true,
				reportResult: input.reportResult,
				hubExecutor: input.hubExecutor,
				executors: input.executors,
			});
		}
		if (input.mode === "spawn") {
			if (input.background === undefined || input.background.trim().length === 0) {
				throw new Error('create_child_agent: "background" is required when mode="spawn".');
			}
			return this.spawnChildAgent(callerAgentId, {
				name: input.name,
				description: input.description,
				background: input.background,
				extends: input.extends,
				hubExecutor: input.hubExecutor,
				executors: input.executors,
			});
		}
		if (input.background !== undefined) {
			throw new Error('create_child_agent: "background" is only valid when mode="spawn".');
		}
		return this.forkChildAgent(callerAgentId, {
			name: input.name,
			description: input.description,
			instructions: input.instructions,
			extends: input.extends,
			hubExecutor: input.hubExecutor,
			executors: input.executors,
		});
	}

	async createTemporaryChildAgent(callerAgentId: string, input: CreateTemporaryChildToolInput): Promise<string> {
		return this.spawnChildAgent(callerAgentId, {
			name: input.name,
			description: input.description,
			background: input.background,
			extends: input.extends,
			temporary: true,
			reportResult: input.reportResult,
		});
	}

	async spawnChildAgent(
		parentAgentId: string,
		input: SpawnChildToolInput & { temporary?: boolean; reportResult?: boolean },
	): Promise<string> {
		this.agentRegistry.require(parentAgentId);
		let record = this.agentRegistry.createChildResolvingSessionPath({
			parentId: parentAgentId,
			name: input.name,
			description: input.description,
			createdBy: parentAgentId,
			spawnMode: "spawn",
			background: input.background,
			lifecycle: input.temporary === true ? "temporary" : "persistent",
			reportResult: input.temporary === true ? input.reportResult !== false : undefined,
			hubExecutor: input.hubExecutor,
		});
		const executors = this.createContainerExecutorConfigs(parentAgentId, record.id, input.executors);
		if (executors !== undefined) {
			this.agentRegistry.update({ ...record, executors });
			record = this.agentRegistry.require(record.id);
		}
		initializeChildAgentDirectory(this.cwd, record.id);
		this.writeChildResourceExtendsConfig(record.id, input.extends);
		const paths = assertWorkspaceInitialized(this.cwd);
		const sm = SessionManager.open(record.sessionFile, paths.workspaceDir, this.cwd);
		sm.appendMessage({ role: "user", content: String(input.background), timestamp: Date.now() });
		HubRuntime.materializeSessionManagerToDisk(sm, record.sessionFile);
		this.agentRegistry.save();
		try {
			this.manuallyStoppedAgentIds.delete(record.id);
			const child = await this.addAndStartNewChildFromRegistry(this.agentRegistry.require(record.id));
			await this.refreshSourcesForChildExtends(input.extends);
			this.continueChildCurrentTranscript(child);
			this.refreshAgentListViews();
		} catch (e) {
			this.rollbackPersistedChildRecordIfPresent(record);
			throw e;
		}
		return JSON.stringify(
			{
				ok: true,
				childId: record.id,
				sessionFile: record.sessionFile,
				status: "started" as const,
				peerConnectCommand: this.createPeerConnectCommand(record.id),
				peerIdNote: "--peer-id only sets the peer identity; use --agent to choose the target agent.",
			},
			null,
			2,
		);
	}

	private createContainerExecutorConfigs(
		parentAgentId: string,
		childAgentId: string,
		inputExecutors: SpawnChildToolInput["executors"] | undefined,
	): AgentExecutorConfig[] | undefined {
		if (inputExecutors === undefined) {
			return undefined;
		}
		return inputExecutors.map((executor) => {
			const token = this.authTokenStore.createScopedToken({
				name: `container executor ${executor.id}`,
				description: `Container peer executor ${executor.peerId} for child agent ${childAgentId}.`,
				user: `container executor ${executor.id}`,
				purpose: `Run container peer executor ${executor.peerId} for child agent ${childAgentId}.`,
				scopeRootAgentId: childAgentId,
				createdByAgentId: parentAgentId,
			}).token;
			return {
				id: executor.id,
				type: "node-container" as const,
				peerId: executor.peerId,
				image: executor.image ?? "node:22",
				command: [...executor.command],
				token,
				...(executor.env !== undefined ? { env: executor.env } : {}),
				...(executor.workdir !== undefined ? { workdir: executor.workdir } : {}),
				...(executor.containerName !== undefined ? { containerName: executor.containerName } : {}),
			};
		});
	}

	async groupText(callerAgentId: string): Promise<string> {
		const caller = this.agentRegistry.require(callerAgentId);
		const agents = this.getAgentRecords().map((record) => {
			const runtime = this.tryGetAgentRuntime(record.id);
			const snapshot = runtime?.sessionService.getSnapshot();
			return {
				id: record.id,
				kind: record.kind,
				parentId: record.parentId,
				name: record.name,
				description: record.description,
				lifecycle: record.lifecycle,
				reportResult: record.reportResult,
				spawnMode: record.spawnMode,
				sessionFile: record.sessionFile,
				status: this.getAgentHydrationStatus(record.id),
				peerCount: runtime?.peerRegistry.size() ?? 0,
				isRunning: snapshot?.isRunning ?? false,
				isWorking: snapshot?.isRunning ?? false,
				lastError: snapshot?.lastError,
			};
		});
		const hostExecutorEnabled = caller.hubExecutor !== "disabled";
		const executors = [
			...(hostExecutorEnabled ? [createHostPeerRecord(callerAgentId, this.cwd)] : []),
			...this.getVisibleExecutorPeersForAgent(callerAgentId),
		].map((peer) => ({
			agentId: peer.agentId,
			peerId: peer.peerId,
			transport: peer.transport,
			displayName: peer.displayName,
			hostname: peer.hostname,
			cwd: peer.cwd,
			tools: peer.tools,
			connectedAt: peer.connectedAt,
		}));
		return JSON.stringify(
			{
				self: {
					id: caller.id,
					kind: caller.kind,
					name: caller.name,
					description: caller.description,
				},
				fieldNotes: {
					"agents.status":
						'Hub runtime availability for this agent: "running" means the hub has an active agent runtime.',
					"agents.peerCount":
						"peerCount is connected d-pi peer client count only. Browser Web UI host connections are not counted because they are remote UIs, not tool executors. peerCount=0 does not mean the agent is offline, unavailable, or unable to receive agent messages.",
					"agents.isRunning": "Whether the agent is currently processing a turn.",
					"agents.isWorking": "Alias of agents.isRunning for compatibility with older prompts.",
					"executors.peerId": hostExecutorEnabled
						? 'Tool executor id for routed peer tools. Use peer-id "host" to run tools on the D-Pi hub host workspace. Browser Web UI host connections are not executor peerIds.'
						: "Tool executor id for routed peer tools. The D-Pi hub host executor is disabled for this agent. Browser Web UI host connections are not executor peerIds.",
				},
				agents,
				executors,
				tips: [
					...(hostExecutorEnabled
						? ['Use peer-id "host" to run routed tools on the D-Pi hub host workspace.']
						: []),
					"Use send_message_to_agent to send targeted messages to one or more other agents.",
					"Use broadcast_message_to_agents when every other agent should receive the same note.",
					"Keep child agent descriptions current so group discovery stays useful.",
				],
			},
			null,
			2,
		);
	}

	async updateAgentDescriptionText(callerAgentId: string, input: UpdateAgentDescriptionToolInput): Promise<string> {
		const caller = this.agentRegistry.require(callerAgentId);
		const targetAgentId = input.agentId ?? callerAgentId;
		const target = this.agentRegistry.require(targetAgentId);
		if (target.kind !== "child") {
			throw new Error("update_agent_description: root agent description is not editable through this tool.");
		}
		if (!this.agentRegistry.isInSubtree(caller.id, target.id)) {
			throw new Error("update_agent_description: agents can update only themselves or descendants.");
		}
		this.agentRegistry.update({ ...target, description: input.description });
		this.agentRegistry.save();
		this.refreshAgentListViews();
		return JSON.stringify(
			{
				ok: true,
				agentId: target.id,
				description: input.description,
			},
			null,
			2,
		);
	}

	async updateChildAgent(callerAgentId: string, input: UpdateChildToolInput): Promise<string> {
		const target = this.requireChildRecordForLifecycle(input.agentId, "update_child_agent");
		const updatesMetadata = input.name !== undefined || input.description !== undefined;
		const updatesHubExecutor = input.hubExecutor !== undefined;
		const updatesExecutors = input.executors !== undefined;
		if (!updatesMetadata && !updatesHubExecutor && !updatesExecutors) {
			throw new Error("update_child_agent: at least one field must be provided.");
		}
		if (updatesMetadata && !this.agentRegistry.isInSubtree(callerAgentId, target.id)) {
			throw new Error("update_child_agent: agents can update metadata only for themselves or descendants.");
		}
		if ((updatesHubExecutor || updatesExecutors) && target.parentId !== callerAgentId) {
			throw new Error("update_child_agent: executor policy can be changed only by the target child direct parent.");
		}
		if (updatesExecutors && this.agentRuntimes.has(target.id)) {
			throw new Error(
				"update_child_agent: container executor config can be changed only when the child must be stopped.",
			);
		}
		const next = { ...target };
		if (input.name !== undefined) {
			next.name = input.name;
		}
		if (input.description !== undefined) {
			next.description = input.description;
		}
		if (input.hubExecutor !== undefined) {
			next.hubExecutor = input.hubExecutor;
		}
		if (input.executors !== undefined) {
			next.executors = this.createContainerExecutorConfigs(callerAgentId, target.id, input.executors) ?? [];
		}
		this.agentRegistry.update(next);
		this.agentRegistry.save();
		const runtime = this.tryGetAgentRuntime(next.id);
		if (runtime) {
			if (input.name !== undefined) runtime.record.name = input.name;
			if (input.description !== undefined) runtime.record.description = input.description;
			if (input.hubExecutor !== undefined) runtime.record.hubExecutor = input.hubExecutor;
		}
		this.refreshAgentListViews();
		return JSON.stringify(
			{
				ok: true,
				childId: next.id,
				name: next.name,
				description: next.description,
				hubExecutor: next.hubExecutor ?? "enabled",
				executors: next.executors,
			},
			null,
			2,
		);
	}

	async renameChildAgent(callerAgentId: string, input: RenameChildToolInput): Promise<string> {
		const target = this.requireChildRecordForLifecycle(input.agentId, "rename_child_agent");
		if (target.parentId !== callerAgentId) {
			throw new Error("rename_child_agent: child agent id can be changed only by the target child direct parent.");
		}
		if (this.agentRuntimes.has(target.id)) {
			throw new Error("rename_child_agent: child agent id can be changed only when the child must be stopped.");
		}
		const newAgentId = this.agentRegistry.resolveNewChildAgentId(input.newAgentId);
		const oldDir = getChildAgentDir(this.cwd, target.id);
		const newDir = getChildAgentDir(this.cwd, newAgentId);
		if (!existsSync(oldDir)) {
			throw new Error(`rename_child_agent: child directory does not exist for agent "${target.id}".`);
		}
		if (existsSync(newDir)) {
			throw new Error(`rename_child_agent: child directory already exists for agent "${newAgentId}".`);
		}

		renameSync(oldDir, newDir);
		let renamed: AgentRecord;
		try {
			renamed = this.agentRegistry.renameChild(target.id, newAgentId);
			this.agentRegistry.save();
		} catch (e) {
			if (this.agentRegistry.get(newAgentId) !== undefined && this.agentRegistry.get(target.id) === undefined) {
				this.agentRegistry.renameChild(newAgentId, target.id);
			}
			if (existsSync(newDir) && !existsSync(oldDir)) {
				renameSync(newDir, oldDir);
			}
			throw e;
		}

		for (const child of this.agentRegistry.getChildren(renamed.id)) {
			const runtime = this.tryGetAgentRuntime(child.id);
			if (runtime) {
				runtime.record.parentId = renamed.id;
			}
		}
		this.log("info", "child agent renamed", { oldAgentId: target.id, newAgentId: renamed.id });
		this.refreshAgentListViews();
		return JSON.stringify(
			{
				ok: true,
				oldAgentId: target.id,
				childId: renamed.id,
				sessionFile: renamed.sessionFile,
			},
			null,
			2,
		);
	}

	async createAgentTokenText(callerAgentId: string, input: CreateAgentTokenToolInput): Promise<string> {
		const caller = this.agentRegistry.require(callerAgentId);
		const created = this.authTokenStore.createScopedToken({
			name: input.name.trim(),
			description: input.description.trim(),
			user: input.user.trim(),
			purpose: input.purpose.trim(),
			scopeRootAgentId: caller.id,
			createdByAgentId: caller.id,
		});
		return JSON.stringify(
			{
				ok: true,
				token: created.token,
				tokenId: created.record.id,
				name: created.record.name,
				description: created.record.description,
				user: created.record.user,
				purpose: created.record.purpose,
				scopeRootAgentId: created.record.scopeRootAgentId,
				createdByAgentId: created.record.createdByAgentId,
				note: "This token is shown in this response and stored in the hub auth registry. Store it securely.",
			},
			null,
			2,
		);
	}

	async revokeAgentTokenText(callerAgentId: string, input: RevokeAgentTokenToolInput): Promise<string> {
		this.agentRegistry.require(callerAgentId);
		const tokenId = input.tokenId.trim();
		if (!tokenId) {
			throw new Error("revoke_agent_token: tokenId is required.");
		}
		const identity = this.authTokenStore.getMetadata(tokenId);
		if (!identity) {
			throw new Error(`revoke_agent_token: unknown token id "${tokenId}".`);
		}
		this.assertAgentInSubtree(callerAgentId, identity.scopeRootAgentId, "revoke_agent_token");
		const revoked = this.authTokenStore.revokeToken(tokenId);
		const revokedConnections = this.socketServer.disconnectToken(tokenId);
		return JSON.stringify(
			{
				ok: true,
				tokenId,
				name: revoked?.name ?? identity.name,
				description: revoked?.description ?? identity.description,
				user: revoked?.user ?? identity.user,
				purpose: revoked?.purpose ?? identity.purpose,
				scopeRootAgentId: revoked?.scopeRootAgentId ?? identity.scopeRootAgentId,
				createdByAgentId: revoked?.createdByAgentId ?? identity.createdByAgentId,
				revokedConnections,
			},
			null,
			2,
		);
	}

	async forkChildAgent(parentAgentId: string, input: ForkChildToolInput): Promise<string> {
		const parentRt = this.getAgentRuntime(parentAgentId);
		const parentSm = parentRt.sessionService.getSessionManager();
		const leaf = parentSm.getLeafId();
		if (leaf === null) {
			throw new Error('create_child_agent: mode="fork" requires the current agent session to have a leaf.');
		}
		const paths = assertWorkspaceInitialized(this.cwd);
		const forkSm = SessionManager.open(parentRt.record.sessionFile, paths.workspaceDir, this.cwd);
		let branchedPath: string | undefined;
		try {
			const created = forkSm.createBranchedSession(leaf);
			if (created === undefined) {
				throw new Error('create_child_agent: mode="fork" could not create branched session file.');
			}
			branchedPath = created;
			let record = this.agentRegistry.createChildResolvingSessionPath({
				parentId: parentAgentId,
				name: input.name,
				description: input.description,
				createdBy: parentAgentId,
				spawnMode: "fork",
				hubExecutor: input.hubExecutor,
			});
			const executors = this.createContainerExecutorConfigs(parentAgentId, record.id, input.executors);
			if (executors !== undefined) {
				this.agentRegistry.update({ ...record, executors });
				record = this.agentRegistry.require(record.id);
			}
			initializeChildAgentDirectory(this.cwd, record.id);
			this.writeChildResourceExtendsConfig(record.id, input.extends);
			HubRuntime.materializeSessionManagerToDisk(forkSm, branchedPath);
			renameSync(branchedPath, record.sessionFile);
			branchedPath = undefined;
			if (input.instructions !== undefined && input.instructions.length > 0) {
				const csm = SessionManager.open(record.sessionFile, paths.workspaceDir, this.cwd);
				csm.appendMessage({ role: "user", content: String(input.instructions), timestamp: Date.now() });
				HubRuntime.materializeSessionManagerToDisk(csm, record.sessionFile);
			}
			this.agentRegistry.save();
			try {
				const child = await this.addAndStartNewChildFromRegistry(this.agentRegistry.require(record.id));
				await this.refreshSourcesForChildExtends(input.extends);
				if (input.instructions !== undefined && input.instructions.length > 0) {
					this.continueChildCurrentTranscript(child);
				}
				this.refreshAgentListViews();
			} catch (e) {
				this.rollbackPersistedChildRecordIfPresent(record);
				throw e;
			}
			return JSON.stringify(
				{
					ok: true,
					childId: record.id,
					sessionFile: record.sessionFile,
					status: "started" as const,
					peerConnectCommand: this.createPeerConnectCommand(record.id),
					peerIdNote: "--peer-id only sets the peer identity; use --agent to choose the target agent.",
				},
				null,
				2,
			);
		} catch (e) {
			if (branchedPath !== undefined) {
				HubRuntime.tryUnlinkFile(branchedPath);
			}
			throw e;
		}
	}

	private requireChildRecordForLifecycle(agentId: string, action: string): AgentRecord {
		if (agentId === ROOT_AGENT_ID) {
			throw new Error(`${action}: cannot operate on root agent "${ROOT_AGENT_ID}"; target must be a child agent.`);
		}
		const record = this.agentRegistry.require(agentId);
		if (record.kind !== "child") {
			throw new Error(`${action}: agent "${agentId}" is not a child agent.`);
		}
		return record;
	}

	async stopChildAgent(callerAgentId: string, input: StopChildToolInput): Promise<string> {
		this.assertAgentInSubtree(callerAgentId, input.agentId, "stop_child_agent");
		const record = this.requireChildRecordForLifecycle(input.agentId, "stop_child_agent");
		const runtime = this.agentRuntimes.get(record.id);
		const disconnectedPeers = runtime?.peerRegistry.size() ?? 0;
		this.manuallyStoppedAgentIds.add(record.id);
		if (runtime) {
			this.stopContainerExecutorsForAgent(record.id);
			for (const peer of runtime.peerRegistry.list()) {
				this.configLayers.removePeerSnapshot(record.id, peer.peerId);
			}
			this.socketServer.disconnectAgentPeers(record.id);
			this.unwireLiveEventsForAgent(record.id);
			this.unwireSessionFanoutForAgent(record.id);
			this.unwireSessionLogForAgent(record.id);
			this.agentRuntimes.delete(record.id);
			await runtime.stop();
			this.log("info", "child agent stopped", { agentId: record.id, disconnectedPeers });
		}
		this.refreshAgentListViews();
		return JSON.stringify(
			{
				ok: true,
				childId: record.id,
				status: "stopped" as const,
				wasRunning: runtime !== undefined,
				disconnectedPeers,
			},
			null,
			2,
		);
	}

	async startChildAgent(callerAgentId: string, input: StartChildToolInput): Promise<string> {
		this.assertAgentInSubtree(callerAgentId, input.agentId, "start_child_agent");
		const record = this.requireChildRecordForLifecycle(input.agentId, "start_child_agent");
		const existing = this.agentRuntimes.get(record.id);
		if (existing?.agentAdapter) {
			return JSON.stringify(
				{
					ok: true,
					childId: record.id,
					status: "already_running" as const,
					sessionFile: record.sessionFile,
					peerConnectCommand: this.createPeerConnectCommand(record.id),
				},
				null,
				2,
			);
		}
		this.manuallyStoppedAgentIds.delete(record.id);
		await this.addAndStartNewChildFromRegistry(record);
		this.refreshAgentListViews();
		return JSON.stringify(
			{
				ok: true,
				childId: record.id,
				status: "started" as const,
				sessionFile: record.sessionFile,
				peerConnectCommand: this.createPeerConnectCommand(record.id),
			},
			null,
			2,
		);
	}

	async removeChildAgent(callerAgentId: string, input: RemoveChildToolInput): Promise<string> {
		this.assertAgentInSubtree(callerAgentId, input.agentId, "remove_child_agent");
		return this.removeChildAgentInternal(input.agentId, input.deleteFiles === true);
	}

	private async removeChildAgentInternal(agentId: string, deleteFiles: boolean): Promise<string> {
		const record = this.requireChildRecordForLifecycle(agentId, "remove_child_agent");
		const subtreeIds = [...this.agentRegistry.getDescendantIds(record.id)].reverse();
		for (const descendantId of subtreeIds) {
			await this.removeChildAgentInternal(descendantId, deleteFiles);
		}
		const wasRunning = this.agentRuntimes.has(record.id);
		if (wasRunning) {
			await this.stopChildAgent(ROOT_AGENT_ID, { agentId: record.id });
		}
		const revokedTokens = this.revokeTokensScopedToAgents([record.id]);
		const temporaryUnsub = this.temporaryCleanupUnsubs.get(record.id);
		if (temporaryUnsub) {
			temporaryUnsub();
			this.temporaryCleanupUnsubs.delete(record.id);
		}
		this.configLayers.removeAgentSnapshots(record.id);
		this.manuallyStoppedAgentIds.delete(record.id);
		this.agentRegistry.removeChild(record.id);
		this.agentRegistry.save();
		if (deleteFiles) {
			rmSync(getChildAgentDir(this.cwd, record.id), { recursive: true, force: true });
		}
		this.refreshAgentListViews();
		this.log("info", "child agent removed", {
			agentId: record.id,
			wasRunning,
			revokedTokens: revokedTokens.revokedTokens,
			revokedConnections: revokedTokens.revokedConnections,
		});
		return JSON.stringify(
			{
				ok: true,
				childId: record.id,
				status: "removed" as const,
				wasRunning,
				filesDeleted: deleteFiles,
				childDir: getChildAgentDir(this.cwd, record.id),
				revokedTokens: revokedTokens.revokedTokens,
				revokedConnections: revokedTokens.revokedConnections,
			},
			null,
			2,
		);
	}

	private revokeTokensScopedToAgents(agentIds: Iterable<string>): {
		revokedTokens: number;
		revokedConnections: number;
	} {
		const revoked = this.authTokenStore.revokeTokensScopedTo(agentIds);
		let revokedConnections = 0;
		for (const token of revoked) {
			revokedConnections += this.socketServer.disconnectToken(token.id);
		}
		return { revokedTokens: revoked.length, revokedConnections };
	}

	async listAgentsText(): Promise<string> {
		return JSON.stringify(
			this.getAgentRecords().map((r) => {
				const rt = this.tryGetAgentRuntime(r.id);
				const snap = rt?.sessionService.getSnapshot();
				return {
					id: r.id,
					kind: r.kind,
					parentId: r.parentId,
					name: r.name,
					description: r.description,
					lifecycle: r.lifecycle,
					reportResult: r.reportResult,
					sessionFile: r.sessionFile,
					spawnMode: r.spawnMode,
					background: r.background,
					hydrationStatus: this.getAgentHydrationStatus(r.id),
					peerCount: rt?.peerRegistry.size() ?? 0,
					isRunning: snap?.isRunning ?? false,
					lastError: snap?.lastError,
				};
			}),
			null,
			2,
		);
	}

	private static messageHasOmittableToolContent(m: unknown): boolean {
		if (typeof m !== "object" || m === null) {
			return false;
		}
		const o = m as { role?: string; content?: unknown; toolCalls?: unknown[] };
		if (o.role === "toolResult") {
			return true;
		}
		if (o.role === "assistant") {
			if (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) {
				return true;
			}
			if (Array.isArray(o.content)) {
				return o.content.some(
					(b) => b && typeof b === "object" && "type" in b && (b as { type: string }).type === "toolCall",
				);
			}
		}
		return false;
	}

	private static messagePlainText(m: SessionMessageEntry["message"]): string {
		if (m.role === "user") {
			const c = m.content;
			if (typeof c === "string") {
				return c;
			}
			if (Array.isArray(c)) {
				return c
					.map((p) => {
						if (p && typeof p === "object" && "type" in p && p.type === "text" && "text" in p) {
							return String((p as { text: string }).text);
						}
						return "";
					})
					.join("");
			}
			return JSON.stringify(c);
		}
		if (m.role === "assistant") {
			const c = m.content;
			if (typeof c === "string") {
				return c;
			}
			if (Array.isArray(c)) {
				return c
					.map((p) => {
						if (p && typeof p === "object" && "type" in p && p.type === "text" && "text" in p) {
							return String((p as { text: string }).text);
						}
						return "";
					})
					.join("");
			}
			return JSON.stringify(m);
		}
		if (m.role === "toolResult") {
			const c = m.content;
			if (
				Array.isArray(c) &&
				c[0] &&
				typeof c[0] === "object" &&
				"type" in c[0] &&
				c[0].type === "text" &&
				"text" in c[0]
			) {
				return String((c[0] as { text: string }).text);
			}
			return JSON.stringify(m);
		}
		return JSON.stringify(m);
	}

	private static formatSessionMessageForHistory(entry: SessionMessageEntry): string {
		const m = entry.message;
		const preview = HubRuntime.messagePlainText(m);
		return `${m.role}: ${preview}`;
	}

	async readAgentHistoryText(callerAgentId: string, input: ReadAgentHistoryToolInput): Promise<string> {
		this.assertAgentInSubtree(callerAgentId, input.agentId, "read_agent_history");
		const rt = this.ensureAgentRuntimeRegistered(input.agentId);
		if (!rt) {
			throw new Error(`Unknown agent id: ${input.agentId}`);
		}
		const sm = rt.sessionService.getSessionManager();
		const br = sm.getBranch();
		const asMessages: SessionMessageEntry[] = br.filter((e): e is SessionMessageEntry => e.type === "message");
		const withToolFilter =
			input.includeToolResults === false
				? asMessages.filter((e) => !HubRuntime.messageHasOmittableToolContent(e.message))
				: asMessages;
		const lim = input.limit !== undefined && Number.isFinite(input.limit) ? Math.floor(input.limit) : 32;
		const safeLim = lim < 1 ? 1 : lim;
		const slice = withToolFilter.slice(-safeLim);
		const text = slice.map((e) => HubRuntime.formatSessionMessageForHistory(e)).join("\n");
		return text;
	}

	async start(options: StartHubRuntimeOptions = {}): Promise<SocketHubServerAddress> {
		const startedAt = Date.now();
		const address = await this.socketServer.start({
			host: options.host ?? getListenHost(),
			port: options.port ?? getListenPort(),
		});
		this.socketAddress = address;
		this.log("info", "hub startup timing", {
			phase: "socket_listen",
			durationMs: Date.now() - startedAt,
		});
		this.startBackgroundChildHydration();
		void this.startSourceHostAfterChildHydration().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.log("error", "source startup failed", { error: message });
		});
		await this.startContainerExecutorsForRunningAgents();
		return address;
	}

	/**
	 * Terminal shutdown for this `HubRuntime` instance: tears down live forwarding, every `HubAgentRuntime`, source and
	 * MCP hosts, and the socket server, then **clears** the internal agent-runtime map. Do not reuse this instance;
	 * open a new hub with `HubRuntime.open()` if you need another lifecycle.
	 */
	async stop(): Promise<void> {
		this.stopping = true;
		this.stopAllContainerExecutors();
		for (const e of this.sessionFanout) {
			for (const subscription of e.subscriptions) {
				subscription.unsubscribe();
			}
		}
		this.sessionFanout = [];
		for (const unsubscribe of this.sessionLogUnsubs.values()) {
			unsubscribe();
		}
		this.sessionLogUnsubs.clear();
		for (const u of this.liveEventUnsubs) {
			u.unsubscribe();
		}
		this.liveEventUnsubs = [];
		for (const rt of this.agentRuntimes.values()) {
			await rt.stop();
		}
		this.agentRuntimes.clear();
		await this.sourceHost.stop();
		try {
			await this.mcpHost.stop();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error(`d-pi hub: error stopping McpHost: ${message}`);
		}
		await this.socketServer.stop();
	}
}
