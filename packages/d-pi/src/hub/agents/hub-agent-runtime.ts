import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSessionServices, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HubAgentAdapter } from "../agent/hub-agent-adapter.js";
import type { CreateHubAgentAdapterOptions } from "../agent/types.js";
import { type AgentTokenToolHost, createAgentTokenToolDefinitions } from "../auth/token-tools.js";
import type { PeerConfigJsonLayers } from "../config-aggregation/types.js";
import type { McpClientHandle } from "../mcp/mcp-client.js";
import { McpHost } from "../mcp/mcp-host.js";
import type { McpServerConfig } from "../mcp/types.js";
import { PeerRegistry } from "../peers/peer-registry.js";
import type { RegisteredPeer } from "../peers/peer-types.js";
import type { HubSessionService } from "../session/hub-session-service.js";
import { createHubTools } from "../tools/index.js";
import { PeerToolBridge } from "../tools/peer-tool-bridge.js";
import type { LiveRenderEvent } from "../transport/live-events.js";
import type { SocketHubServer } from "../transport/socket-hub-server.js";
import type { HubLogSink } from "../tui/hub-log.js";
import { type AgentMessagingToolHost, createAgentMessagingToolDefinitions } from "./agent-messaging-tools.js";
import { type ChildAgentToolHost, createChildAgentToolDefinitions } from "./child-agent-tools.js";
import { createGroupToolDefinitions, type GroupToolHost } from "./group-tools.js";
import { createReloadConfigToolDefinition } from "./reload-config-tool.js";
import type { AgentRecord } from "./types.js";

const START_ABORTED_MESSAGE = "HubAgentRuntime: start() aborted by stop()";
const START_AFTER_STOP_MESSAGE = "HubAgentRuntime: cannot start() after stop()";

export interface HubAgentRuntimeOptions {
	cwd: string;
	record: AgentRecord;
	sessionService: HubSessionService;
	socketServer: SocketHubServer;
	/** If omitted, a new `PeerRegistry` is created. Hub orchestration can inject the main registry to match the socket. */
	peerRegistry?: PeerRegistry;
	agentDir?: string;
	getConfigLayers?: () => PeerConfigJsonLayers[];
	mcp?: {
		configPath: string;
		configRoot?: () => unknown;
		createClient?: (config: McpServerConfig, opts: { timeoutMs: number }) => Promise<McpClientHandle>;
	};
	createAgentAdapter?: (options: CreateHubAgentAdapterOptions) => Promise<HubAgentAdapter>;
	sharedTools?: ToolDefinition[];
	agentTools?: ToolDefinition[];
	refreshSources?: () => Promise<void>;
	refreshMcp?: () => Promise<void>;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	services?: AgentSessionServices;
	prepareServices?: (services: AgentSessionServices) => Promise<void> | void;
	beforeInputQueueDrain?: CreateHubAgentAdapterOptions["beforeInputQueueDrain"];
	logs?: HubLogSink;
	/** When set on the main agent, registers main-only child management tools. */
	getChildAgentHost?: () => ChildAgentToolHost;
	/** Resolves `HubRuntime` (or test double) for agent-to-agent messaging tools; all hub agents use this. */
	getAgentMessagingHost?: () => AgentMessagingToolHost;
	/** Resolves `HubRuntime` for group identity and agent description tools; all hub agents use this. */
	getGroupHost?: () => GroupToolHost;
	/** Resolves `HubRuntime` for creating scoped access tokens; all hub agents use this. */
	getAgentTokenHost?: () => AgentTokenToolHost;
	/** Resolves executor peers visible to this agent's tree scope. */
	resolvePeerForTool?: (callerAgentId: string, peerId: string) => RegisteredPeer | undefined;
}

/**
 * Per-agent shell: session service wiring, peer registry/bridge, tools, and optional hub agent adapter.
 * Intended for future multi-agent `HubRuntime` orchestration; safe to use for a single main agent.
 *
 * **Lifecycle:** each instance is one-shot. After `stop()` finishes, the bridge is disposed and
 * the runtime is closed. To run an agent again, construct a new `HubAgentRuntime` (or have
 * orchestration do so) rather than reusing a stopped instance.
 */
export class HubAgentRuntime {
	readonly record: AgentRecord;
	readonly sessionService: HubSessionService;
	readonly peerRegistry: PeerRegistry;
	readonly peerToolBridge: PeerToolBridge;
	readonly tools: ToolDefinition[];
	readonly mcpHost: McpHost | undefined;
	agentAdapter: HubAgentAdapter | undefined;
	private readonly cwd: string;
	private readonly agentDir?: string;
	private readonly createAgentAdapterImpl: HubAgentRuntimeOptions["createAgentAdapter"];
	private readonly getConfigLayers: HubAgentRuntimeOptions["getConfigLayers"];
	private readonly getChildAgentHost: HubAgentRuntimeOptions["getChildAgentHost"];
	private readonly refreshSources?: () => Promise<void>;
	private readonly refreshMcp?: () => Promise<void>;
	private readonly model?: Model<Api>;
	private readonly thinkingLevel?: ThinkingLevel;
	private readonly scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	private readonly services?: AgentSessionServices;
	private readonly prepareServices?: (services: AgentSessionServices) => Promise<void> | void;
	private readonly beforeInputQueueDrain?: CreateHubAgentAdapterOptions["beforeInputQueueDrain"];
	private readonly logs: HubLogSink | undefined;
	private readonly liveEventSubscribers = new Set<(event: LiveRenderEvent) => void>();
	private readonly remoteMcpToolNames = new Set<string>();
	private adapterLiveUnsub: (() => void) | undefined;
	private startInFlight: Promise<void> | undefined;
	/** `stop()` sets this so `runStart` can avoid committing an adapter (or can dispose) after a slow `create`. */
	private abortStartRequested = false;
	/** `true` from the beginning of `stop()` through full teardown; not cleared until `close()`-equivalent. */
	private closed = false;
	private stopInFlight: Promise<void> | undefined;
	private peerBridgeActive = true;

	constructor(options: HubAgentRuntimeOptions) {
		this.record = options.record;
		this.sessionService = options.sessionService;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.getConfigLayers = options.getConfigLayers;
		this.peerRegistry = options.peerRegistry ?? new PeerRegistry();
		this.peerToolBridge = new PeerToolBridge(this.record.id, this.peerRegistry, options.socketServer, {
			resolvePeer: (peerId) => options.resolvePeerForTool?.(this.record.id, peerId) ?? this.peerRegistry.get(peerId),
		});
		this.getChildAgentHost = options.getChildAgentHost;
		const childManagementTools =
			options.getChildAgentHost != null
				? createChildAgentToolDefinitions(options.getChildAgentHost, options.record.id)
				: [];
		const agentMessagingTools =
			options.getAgentMessagingHost != null
				? createAgentMessagingToolDefinitions(options.getAgentMessagingHost, options.record.id)
				: [];
		const groupTools =
			options.getGroupHost != null ? createGroupToolDefinitions(options.getGroupHost, options.record.id) : [];
		const agentTokenTools =
			options.getAgentTokenHost != null
				? createAgentTokenToolDefinitions(options.getAgentTokenHost, options.record.id)
				: [];
		const reloadConfigTool = createReloadConfigToolDefinition({
			agentId: options.record.id,
			getAdapter: () => this.agentAdapter,
		});
		this.tools = createHubTools({
			cwd: options.cwd,
			agentId: options.record.id,
			peerRegistry: this.peerRegistry,
			peerToolBridge: this.peerToolBridge,
			allowHostExecutor: () => this.record.hubExecutor !== "disabled",
			sharedTools: options.sharedTools,
			agentTools: [
				reloadConfigTool,
				...childManagementTools,
				...groupTools,
				...agentTokenTools,
				...agentMessagingTools,
				...(options.agentTools ?? []),
			],
		});
		this.mcpHost = options.mcp
			? new McpHost({
					cwd: options.cwd,
					customTools: this.tools,
					configPath: options.mcp.configPath,
					configRoot: options.mcp.configRoot,
					createClient: options.mcp.createClient,
					...(options.logs === undefined ? {} : { logs: options.logs }),
				})
			: undefined;
		this.createAgentAdapterImpl = options.createAgentAdapter;
		this.refreshSources = options.refreshSources;
		this.refreshMcp = options.refreshMcp;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel;
		this.scopedModels = options.scopedModels;
		this.services = options.services;
		this.prepareServices = options.prepareServices;
		this.beforeInputQueueDrain = options.beforeInputQueueDrain;
		this.logs = options.logs;
	}

	subscribeLiveEvents(listener: (event: LiveRenderEvent) => void): () => void {
		this.liveEventSubscribers.add(listener);
		return () => {
			this.liveEventSubscribers.delete(listener);
		};
	}

	async start(): Promise<void> {
		if (this.closed) {
			throw new Error(START_AFTER_STOP_MESSAGE);
		}
		if (this.agentAdapter) {
			return;
		}
		if (this.startInFlight) {
			await this.startInFlight;
			if (this.agentAdapter) {
				return;
			}
			if (this.closed) {
				throw new Error(START_AFTER_STOP_MESSAGE);
			}
		}
		this.startInFlight = this.runStart();
		try {
			await this.startInFlight;
		} finally {
			this.startInFlight = undefined;
		}
	}

	private async runStart(): Promise<void> {
		await this.mcpHost?.start();
		this.refreshRemoteMcpTools();
		const create =
			this.createAgentAdapterImpl ?? ((opts: CreateHubAgentAdapterOptions) => HubAgentAdapter.create(opts));
		const adapter = await create({
			agentId: this.record.id,
			cwd: this.cwd,
			agentDir: this.agentDir,
			configLayers: this.getConfigLayers?.(),
			getConfigLayers: this.getConfigLayers,
			getPeerMcpSnapshots: () =>
				this.peerRegistry.list().map((peer) => ({
					peerId: peer.peerId,
					servers: peer.mcpSnapshot?.servers ?? [],
				})),
			sessionService: this.sessionService,
			tools: this.tools,
			services: this.services,
			prepareServices: this.prepareServices,
			beforeInputQueueDrain: this.beforeInputQueueDrain,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			scopedModels: this.scopedModels,
			refreshSources: this.refreshSources,
			refreshMcp: this.refreshMcp ?? (this.mcpHost ? async () => await this.mcpHost?.start() : undefined),
			logs: this.logs,
		});
		if (this.abortStartRequested) {
			adapter.dispose();
			throw new Error(START_ABORTED_MESSAGE);
		}
		this.agentAdapter = adapter;
		this.adapterLiveUnsub = this.agentAdapter.subscribeLiveEvents((event) => {
			for (const listener of this.liveEventSubscribers) {
				listener(event);
			}
		});
	}

	private refreshRemoteMcpTools(): void {
		let writeIndex = 0;
		for (let readIndex = 0; readIndex < this.tools.length; readIndex++) {
			const tool = this.tools[readIndex];
			if (tool && !this.remoteMcpToolNames.has(tool.name)) {
				this.tools[writeIndex] = tool;
				writeIndex++;
			}
		}
		this.tools.length = writeIndex;
		this.remoteMcpToolNames.clear();
	}

	async restartAdapter(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.adapterLiveUnsub?.();
		this.adapterLiveUnsub = undefined;
		const adapter = this.agentAdapter;
		if (adapter) {
			try {
				await adapter.abort();
			} catch {
				// Restart should still replace the adapter if abort races with provider teardown.
			}
			adapter.dispose();
		}
		this.agentAdapter = undefined;
		await this.start();
	}

	async stop(): Promise<void> {
		if (this.closed) {
			return;
		}
		if (this.stopInFlight) {
			await this.stopInFlight;
			return;
		}
		this.stopInFlight = this.runStop();
		try {
			await this.stopInFlight;
		} finally {
			this.stopInFlight = undefined;
		}
	}

	private async runStop(): Promise<void> {
		this.abortStartRequested = true;
		if (this.startInFlight) {
			try {
				await this.startInFlight;
			} catch {
				// `runStart` may reject (e.g. start aborted) — proceed with teardown
			}
		}
		this.adapterLiveUnsub?.();
		this.adapterLiveUnsub = undefined;
		const adapter = this.agentAdapter;
		if (adapter) {
			try {
				await adapter.abort();
			} catch {
				// Stop must be best-effort: dispose below detaches the runtime even if abort races with provider teardown.
			}
			adapter.dispose();
		}
		this.agentAdapter = undefined;
		await this.mcpHost?.stop();
		if (this.peerBridgeActive) {
			this.peerToolBridge.dispose();
			this.peerBridgeActive = false;
		}
		this.abortStartRequested = false;
		this.closed = true;
	}
}
