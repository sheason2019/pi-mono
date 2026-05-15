import type { AssistantMessage } from "@sheason/pi-ai";
import type { AgentToolResult } from "@sheason/pi-coding-agent";
import type {
	HubAgentViewModel,
	HubViewDocumentState,
	HubWelcomePayload,
	RegisteredPeer,
	SessionCrdtSyncFormat,
} from "../../hub/index.js";
import { PeerCrdtState } from "./peer-crdt-state.js";
import { type ImagePayload, PeerImageCache } from "./peer-image-cache.js";

export interface PeerLiveToolExecution {
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	partialResult?: AgentToolResult<unknown>;
	result?: AgentToolResult<unknown>;
	isError?: boolean;
}

export interface PeerLiveSnapshot {
	streamingMessageId?: string;
	streamingMessageIndex?: number;
	streamingMessage?: AssistantMessage;
	toolExecutions: PeerLiveToolExecution[];
	statusMessage?: string;
}

export interface PeerAppSnapshot {
	welcome?: HubWelcomePayload;
	view?: HubViewDocumentState;
	selectedAgent?: HubAgentViewModel;
	live: PeerLiveSnapshot;
	peers: RegisteredPeer[];
}

export class PeerAppState {
	private welcome: HubWelcomePayload | undefined;
	private readonly crdt = new PeerCrdtState();
	private view: HubViewDocumentState | undefined;
	private selectedAgent: HubAgentViewModel | undefined;
	private crdtLive: PeerLiveSnapshot | undefined;
	private localSelectedAgent: HubAgentViewModel | undefined;
	private localLive: PeerLiveSnapshot | undefined;
	private readonly imageCache = new PeerImageCache();
	private peers: RegisteredPeer[] = [];
	private readonly listeners = new Set<(snapshot: PeerAppSnapshot) => void>();
	private scheduledEmit: ReturnType<typeof setImmediate> | undefined;

	subscribe(listener: (snapshot: PeerAppSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	applyWelcome(welcome: HubWelcomePayload): void {
		this.cancelScheduledEmit();
		this.crdt.reset();
		this.welcome = welcome;
		this.view = undefined;
		this.selectedAgent = undefined;
		this.crdtLive = undefined;
		this.localSelectedAgent = undefined;
		this.localLive = undefined;
		this.peers = [];
		this.emit();
	}

	resetCrdtSyncState(): void {
		this.crdt.reset();
	}

	/** For socket layer: collect `imageId`s referenced in payload but not cached yet. */
	collectMissingImageIds(value: unknown): string[] {
		return this.imageCache.collectMissingImageIds(value);
	}

	getImageCache(): PeerImageCache {
		return this.imageCache;
	}

	applyImagePayload(payload: ImagePayload): void {
		this.imageCache.store(payload);
		this.emit();
	}

	applyCrdtSyncMessage(message: Uint8Array, format?: SessionCrdtSyncFormat): { missingImageIds: string[] } {
		const result = this.crdt.applySyncMessage(message, format);
		const view = result.view;
		const selectedAgent = selectCrdtAgent(view, this.welcome?.agentId);
		const projectedLive = projectCrdtLive(view, this.welcome?.agentId);
		const missingImageIds = this.imageCache.collectMissingImageIds({
			agent: selectedAgent,
			live: projectedLive,
			peers: view.peers,
		});
		this.view = view;
		this.selectedAgent = selectedAgent;
		this.crdtLive = projectedLive;
		if (Array.isArray(view.peers)) {
			this.peers = [...view.peers];
		}
		this.scheduleEmit();
		return { missingImageIds };
	}

	getSnapshot(): PeerAppSnapshot {
		return {
			welcome: this.welcome,
			view: this.view,
			selectedAgent: this.localSelectedAgent ?? this.selectedAgent,
			live: this.imageCache.hydrate(this.localLive ?? this.crdtLive ?? { toolExecutions: [] }) as PeerLiveSnapshot,
			peers: [...this.peers],
		};
	}

	applyLocalAgentProjection(agent: HubAgentViewModel, live: PeerLiveSnapshot): void {
		this.localSelectedAgent = agent;
		this.localLive = live;
		this.emit();
	}

	isReady(): boolean {
		return this.welcome !== undefined && this.selectedAgent !== undefined;
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	private scheduleEmit(): void {
		if (this.scheduledEmit) {
			return;
		}
		this.scheduledEmit = setImmediate(() => {
			this.scheduledEmit = undefined;
			this.emit();
		});
		this.scheduledEmit.unref?.();
	}

	private cancelScheduledEmit(): void {
		if (!this.scheduledEmit) {
			return;
		}
		clearImmediate(this.scheduledEmit);
		this.scheduledEmit = undefined;
	}
}

function projectCrdtLive(
	view: HubViewDocumentState,
	preferredAgentId: string | undefined,
): PeerLiveSnapshot | undefined {
	const agent = selectCrdtAgent(view, preferredAgentId);
	if (!agent) {
		return undefined;
	}
	const streamingMessage =
		agent.live.streamingMessageIndex === undefined ? undefined : agent.items[agent.live.streamingMessageIndex];
	return {
		streamingMessageId: agent.live.streamingMessageId,
		streamingMessageIndex: agent.live.streamingMessageIndex,
		streamingMessage:
			streamingMessage?.type === "message" && streamingMessage.message.role === "assistant"
				? streamingMessage.message
				: undefined,
		toolExecutions: agent.live.toolOrder
			.map((toolCallId) => agent.live.toolsById[toolCallId])
			.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined)
			.map((tool) => ({
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				args: tool.args,
				partialResult: tool.partialResult,
				result: tool.result,
				isError: tool.isError,
			})),
		statusMessage: agent.live.statusMessage,
	};
}

function selectCrdtAgent(
	view: HubViewDocumentState,
	preferredAgentId: string | undefined,
): HubAgentViewModel | undefined {
	if (!view.agentsById || !Array.isArray(view.agentOrder)) {
		return undefined;
	}
	if (preferredAgentId) {
		const preferred = view.agentsById[preferredAgentId];
		if (preferred) {
			return preferred;
		}
	}
	const firstAgentId = view.agentOrder[0];
	return firstAgentId ? view.agentsById[firstAgentId] : undefined;
}
