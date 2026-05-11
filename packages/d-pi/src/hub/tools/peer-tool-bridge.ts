import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { PeerRegistry } from "../peers/peer-registry.js";
import type { RegisteredPeer } from "../peers/peer-types.js";
import type { SocketHubServer } from "../transport/socket-hub-server.js";

const DEFAULT_PEER_TOOL_TIMEOUT_MS = 60_000;

export interface ExecutePeerToolOptions<TDetails> {
	toolCallId: string;
	toolName: string;
	peerId: string;
	args: Record<string, unknown>;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TDetails>;
	timeoutMs?: number;
}

interface PendingPeerToolCall {
	peerId: string;
	agentId: string;
	toolName: string;
	timeoutId: ReturnType<typeof setTimeout>;
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	cleanupAbort?: () => void;
}

export interface PeerToolBridgeOptions {
	resolvePeer?: (peerId: string) => RegisteredPeer | undefined;
}

export class PeerToolBridge {
	private readonly pendingCalls = new Map<string, PendingPeerToolCall>();
	private readonly unsubscribePeerRegistry: () => void;
	private readonly unsubscribeToolAck: () => void;
	private readonly unsubscribeToolUpdate: () => void;
	private readonly unsubscribeToolResult: () => void;
	private readonly unsubscribeToolError: () => void;

	constructor(
		private readonly agentId: string,
		private readonly peerRegistry: PeerRegistry,
		private readonly transport: SocketHubServer,
		private readonly options: PeerToolBridgeOptions = {},
	) {
		this.unsubscribePeerRegistry = this.peerRegistry.subscribe((event) => {
			if (event.type === "unregistered") {
				this.failPendingForPeer(
					event.peer.peerId,
					`Peer "${event.peer.peerId}" disconnected during tool execution.`,
				);
			}
		});
		this.unsubscribeToolAck = this.transport.onToolCallAck(({ peer, payload }) => {
			const pendingCall = this.pendingCalls.get(payload.toolCallId);
			if (!pendingCall || pendingCall.peerId !== peer.peerId || pendingCall.agentId !== peer.agentId) {
				return;
			}
		});
		this.unsubscribeToolUpdate = this.transport.onToolCallUpdate(({ peer, payload }) => {
			const pendingCall = this.pendingCalls.get(payload.toolCallId);
			if (!pendingCall || pendingCall.peerId !== peer.peerId || pendingCall.agentId !== peer.agentId) {
				return;
			}
			pendingCall.onUpdate?.(payload.partialResult);
		});
		this.unsubscribeToolResult = this.transport.onToolCallResult(({ peer, payload }) => {
			const pendingCall = this.pendingCalls.get(payload.toolCallId);
			if (!pendingCall || pendingCall.peerId !== peer.peerId || pendingCall.agentId !== peer.agentId) {
				return;
			}
			this.cleanupPendingCall(payload.toolCallId);
			pendingCall.resolve(payload.result);
		});
		this.unsubscribeToolError = this.transport.onToolCallError(({ peer, payload }) => {
			const pendingCall = this.pendingCalls.get(payload.toolCallId);
			if (!pendingCall || pendingCall.peerId !== peer.peerId || pendingCall.agentId !== peer.agentId) {
				return;
			}
			this.cleanupPendingCall(payload.toolCallId);
			pendingCall.reject(new Error(payload.message));
		});
	}

	async executeTool<TDetails>(options: ExecutePeerToolOptions<TDetails>): Promise<AgentToolResult<TDetails>> {
		const peerId = options.peerId.trim();
		if (peerId.length === 0) {
			throw new Error(`Tool "${options.toolName}" requires a non-empty peer-id.`);
		}

		const peer = this.options.resolvePeer?.(peerId) ?? this.peerRegistry.get(peerId);
		if (!peer) {
			throw new Error(`Peer "${peerId}" is offline or not registered.`);
		}
		if (!peer.tools.includes(options.toolName)) {
			throw new Error(`Peer "${peerId}" does not declare support for tool "${options.toolName}".`);
		}
		if (options.signal?.aborted) {
			throw new Error("Operation aborted");
		}

		return new Promise<AgentToolResult<TDetails>>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.cleanupPendingCall(options.toolCallId);
				reject(new Error(`Peer "${peerId}" timed out while executing tool "${options.toolName}".`));
			}, options.timeoutMs ?? DEFAULT_PEER_TOOL_TIMEOUT_MS);

			const pendingCall: PendingPeerToolCall = {
				peerId,
				agentId: peer.agentId,
				toolName: options.toolName,
				timeoutId,
				resolve: (result) => resolve(result as AgentToolResult<TDetails>),
				reject,
				onUpdate: options.onUpdate as AgentToolUpdateCallback<unknown> | undefined,
			};

			if (options.signal) {
				const onAbort = () => {
					this.cleanupPendingCall(options.toolCallId);
					reject(new Error("Operation aborted"));
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				pendingCall.cleanupAbort = () => {
					options.signal?.removeEventListener("abort", onAbort);
				};
			}

			this.pendingCalls.set(options.toolCallId, pendingCall);

			try {
				this.transport.sendToolCallRequest(peer.agentId, peerId, {
					toolCallId: options.toolCallId,
					toolName: options.toolName,
					args: options.args,
					timeoutMs: options.timeoutMs ?? DEFAULT_PEER_TOOL_TIMEOUT_MS,
				});
			} catch (error) {
				this.cleanupPendingCall(options.toolCallId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	dispose(): void {
		this.unsubscribePeerRegistry();
		this.unsubscribeToolAck();
		this.unsubscribeToolUpdate();
		this.unsubscribeToolResult();
		this.unsubscribeToolError();

		for (const toolCallId of [...this.pendingCalls.keys()]) {
			this.cleanupPendingCall(toolCallId);
		}
	}

	private failPendingForPeer(peerId: string, message: string): void {
		for (const [toolCallId, pendingCall] of this.pendingCalls) {
			if (pendingCall.peerId !== peerId) {
				continue;
			}
			this.cleanupPendingCall(toolCallId);
			pendingCall.reject(new Error(message));
		}
	}

	private cleanupPendingCall(toolCallId: string): void {
		const pendingCall = this.pendingCalls.get(toolCallId);
		if (!pendingCall) {
			return;
		}
		clearTimeout(pendingCall.timeoutId);
		pendingCall.cleanupAbort?.();
		this.pendingCalls.delete(toolCallId);
	}
}
