import { io, type Socket } from "socket.io-client";
import type {
	ActionAck,
	ClientToServerEvents,
	GuestAgentMessagePayload,
	McpRuntimeStatus,
	PeerConfigAck,
	PeerConfigPayload,
	PeerHelloAck,
	PeerHelloPayload,
	ServerToClientEvents,
	SessionCrdtSyncPayload,
	SessionGetMcpServersAck,
	SessionGetSkillsAck,
	SessionGetSourcesAck,
	SessionMutateMcpServerAck,
	SessionMutateSourceAck,
	SourceMessagePayload,
	SourceRuntimeStatus,
	ToolCallRequestPayload,
} from "../../hub/index.js";
import type { PeerAppState } from "../state/peer-app-state.js";
import type { ImagePayload } from "../state/peer-image-cache.js";
import type { PeerUiState } from "../state/peer-ui-state.js";

const HANDSHAKE_STAGE_TIMEOUT_MS = 20_000;

function toUint8Array(value: SessionCrdtSyncPayload["message"]): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	return new Uint8Array(value);
}

export interface SocketPeerClientOptions {
	hubUrl: string;
	hello: PeerHelloPayload;
	appState: PeerAppState;
	uiState: PeerUiState;
	reconnectDelayMs?: number;
	handshakeStageTimeoutMs?: number;
	onHandshakeLog?: (message: string) => void;
	reconnection?: boolean;
	onToolCallRequest?: (
		payload: ToolCallRequestPayload,
		socket: Socket<ServerToClientEvents, ClientToServerEvents>,
	) => Promise<void> | void;
	onGuestAgentMessage?: (payload: GuestAgentMessagePayload) => Promise<void> | void;
}

type AckedEventPayloads = {
	"session:queue_write": Parameters<ClientToServerEvents["session:queue_write"]>[0];
	"session:queue_flush": Parameters<ClientToServerEvents["session:queue_flush"]>[0];
	"session:abort": Parameters<ClientToServerEvents["session:abort"]>[0];
	"session:set_model": Parameters<ClientToServerEvents["session:set_model"]>[0];
	"session:set_thinking_level": Parameters<ClientToServerEvents["session:set_thinking_level"]>[0];
	"session:invoke_command": Parameters<ClientToServerEvents["session:invoke_command"]>[0];
	"source:message": SourceMessagePayload;
};

type ScheduledCrdtSyncDrain = { handle: ReturnType<typeof setTimeout> };

export class SocketPeerClient {
	private socket: Socket<ServerToClientEvents, ClientToServerEvents> | undefined;
	private manualDisconnect = false;
	/** Deduplicate concurrent REST image fetches per `imageId` until the response returns. */
	private readonly inFlightImageGetIds = new Set<string>();
	/** Ids to fetch again after the current in-flight REST request returns. */
	private readonly deferredImageGetIds = new Set<string>();
	private readonly failedImageGetIds = new Set<string>();
	private readonly pendingCrdtSyncMessages: { message: Uint8Array; format: SessionCrdtSyncPayload["format"] }[] = [];
	private scheduledCrdtSyncDrain: ScheduledCrdtSyncDrain | undefined;
	private initialCrdtSynced = false;
	private readonly initialCrdtSyncWaiters = new Set<() => void>();

	constructor(private readonly options: SocketPeerClientOptions) {}

	async connect(): Promise<void> {
		if (this.socket?.connected) {
			return;
		}

		this.options.uiState.setConnectionStatus({
			state: "connecting",
			message: `Connecting to hub ${this.options.hubUrl}...`,
		});
		const peerVersion = this.options.hello.version ?? "unknown";
		this.logHandshake(
			`peer v${peerVersion} (protocol v${this.options.hello.protocolVersion}) connecting to hub ${this.options.hubUrl}`,
		);
		this.manualDisconnect = false;
		const handshakeStageTimeoutMs = this.options.handshakeStageTimeoutMs ?? HANDSHAKE_STAGE_TIMEOUT_MS;
		const socket = io(this.options.hubUrl, {
			transports: ["websocket", "polling"],
			tryAllTransports: true,
			timeout: handshakeStageTimeoutMs + 1000,
			reconnection: this.options.reconnection ?? true,
			reconnectionDelay: this.options.reconnectDelayMs ?? 5000,
			reconnectionDelayMax: this.options.reconnectDelayMs ?? 5000,
		});
		this.socket = socket;

		await new Promise<void>((resolve, reject) => {
			let timeoutId = setTimeout(() => {
				if (settled) {
					return;
				}
				socket.disconnect();
				this.logHandshake(`timed out after ${handshakeStageTimeoutMs}ms waiting for hub welcome`);
				this.options.uiState.setConnectionStatus({
					state: "error",
					message: `Timed out connecting to hub ${this.options.hubUrl}`,
				});
				settled = true;
				reject(new Error(`Timed out connecting to hub ${this.options.hubUrl}`));
			}, handshakeStageTimeoutMs);
			let resolved = false;
			let settled = false;
			let helloAckComplete = false;
			let welcomeComplete = false;
			const fail = (message: string, error = new Error(message)) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeoutId);
				socket.disconnect();
				this.options.uiState.setConnectionStatus({ state: "error", message });
				reject(error);
			};
			const maybeResolve = () => {
				if (settled || resolved || !helloAckComplete || !welcomeComplete) {
					return;
				}
				resolved = true;
				settled = true;
				clearTimeout(timeoutId);
				this.options.uiState.setConnectionStatus({
					state: "connecting",
					message: "Connected to hub. Uploading peer config...",
				});
				this.logHandshake("hub welcome received; connection/auth stage complete");
				resolve();
			};

			this.installEventHandlers(socket);
			socket.once("hub:welcome", () => {
				welcomeComplete = true;
				this.logHandshake("hub:welcome received");
				maybeResolve();
			});

			socket.on("connect", () => {
				// Fires for each successful transport connection, including auto-reconnect after a drop.
				this.clearImageGetTransportState();
				this.logHandshake("socket connected; sending peer:hello");
				setTimeout(() => {
					if (settled || !socket.connected) {
						return;
					}
					clearTimeout(timeoutId);
					this.logHandshake(`waiting up to ${handshakeStageTimeoutMs}ms for peer:hello ack`);
					const helloTimeoutId = setTimeout(() => {
						const message = `Timed out waiting for peer:hello ack from hub ${this.options.hubUrl}`;
						this.logHandshake(`peer:hello ack timed out after ${handshakeStageTimeoutMs}ms`);
						fail(message, new Error(message));
					}, handshakeStageTimeoutMs);
					socket.emit("peer:hello", this.options.hello, (ack: PeerHelloAck | undefined) => {
						clearTimeout(helloTimeoutId);
						if (!ack) {
							const message = "Hub did not return a peer:hello acknowledgement.";
							this.logHandshake(message);
							fail(message);
							return;
						}
						if (!ack.ok) {
							this.logHandshake(`peer:hello rejected: ${ack.error}`);
							fail(ack.error, new Error(ack.error));
							return;
						}
						helloAckComplete = true;
						this.logHandshake("peer:hello ack received");
						if (!welcomeComplete) {
							timeoutId = setTimeout(() => {
								if (settled) {
									return;
								}
								socket.disconnect();
								this.logHandshake(`timed out after ${handshakeStageTimeoutMs}ms waiting for hub welcome`);
								this.options.uiState.setConnectionStatus({
									state: "error",
									message: `Timed out connecting to hub ${this.options.hubUrl}`,
								});
								settled = true;
								reject(new Error(`Timed out connecting to hub ${this.options.hubUrl}`));
							}, handshakeStageTimeoutMs);
						}
						maybeResolve();
					});
				}, 0);
			});

			socket.on("connect_error", (error) => {
				clearTimeout(timeoutId);
				if (resolved) {
					this.logHandshake(`socket reconnecting after connection error: ${error.message}`);
					this.options.uiState.setConnectionStatus({
						state: "reconnecting",
						message: `Connection lost (${error.message}). Socket.IO reconnecting.`,
					});
					return;
				}
				socket.disconnect();
				this.logHandshake(`socket connection error: ${error.message}`);
				this.options.uiState.setConnectionStatus({ state: "error", message: error.message });
				reject(error);
			});
		});
	}

	async uploadConfig(config: PeerConfigPayload): Promise<void> {
		const socket = this.requireSocket();
		this.options.uiState.setConnectionStatus({
			state: "connecting",
			message: "Uploading peer config...",
		});
		this.logHandshake("uploading peer config");
		await new Promise<void>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.logHandshake(`timed out after ${HANDSHAKE_STAGE_TIMEOUT_MS}ms uploading peer config`);
				reject(new Error(`Timed out uploading peer config to hub ${this.options.hubUrl}`));
			}, HANDSHAKE_STAGE_TIMEOUT_MS);
			socket.emit("peer:config", config, (ack: PeerConfigAck) => {
				clearTimeout(timeoutId);
				if (!ack.ok) {
					this.logHandshake(`peer:config rejected: ${ack.error}`);
					this.options.uiState.setConnectionStatus({ state: "error", message: ack.error });
					reject(new Error(ack.error));
					return;
				}
				this.options.uiState.setConnectionStatus({
					state: "connecting",
					message: "Peer config uploaded. Waiting for session sync...",
				});
				this.logHandshake("peer:config ack received; waiting for initial session sync");
				resolve();
			});
		});
	}

	async waitForInitialSync(): Promise<void> {
		if (this.initialCrdtSynced) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.initialCrdtSyncWaiters.delete(done);
				this.logHandshake(`timed out after ${HANDSHAKE_STAGE_TIMEOUT_MS}ms waiting for initial session sync`);
				reject(new Error(`Timed out waiting for session sync from hub ${this.options.hubUrl}`));
			}, HANDSHAKE_STAGE_TIMEOUT_MS);
			const done = () => {
				clearTimeout(timeoutId);
				this.logHandshake("initial session sync received; peer handshake complete");
				resolve();
			};
			this.initialCrdtSyncWaiters.add(done);
		});
	}

	async disconnect(): Promise<void> {
		this.manualDisconnect = true;
		const socket = this.socket;
		socket?.removeAllListeners();
		socket?.io.removeAllListeners();
		socket?.disconnect();
		socket?.close();
		this.socket = undefined;
		this.initialCrdtSynced = false;
		this.clearPendingCrdtSyncMessages();
		this.clearImageGetTransportState();
		this.options.uiState.setConnectionStatus({
			state: "disconnected",
			message: "Disconnected from hub.",
		});
	}

	retryConnectionNow(): void {
		if (!this.socket || this.socket.connected) {
			return;
		}
		this.options.uiState.setConnectionStatus({
			state: "reconnecting",
			message: "Retrying connection to hub now...",
		});
		this.socket.connect();
	}

	async queueWrite(text: string): Promise<void> {
		await this.emitAcked("session:queue_write", { text, sentAt: new Date().toISOString() });
	}

	async queueFlush(): Promise<void> {
		await this.emitAcked("session:queue_flush", {});
	}

	async sendSourceMessage(payload: SourceMessagePayload): Promise<void> {
		await this.emitAcked("source:message", payload);
	}

	async abort(): Promise<void> {
		this.options.uiState.setCancelling(true);
		try {
			await this.emitAcked("session:abort", {});
		} catch (error) {
			this.options.uiState.setCancelling(false);
			throw error;
		}
	}

	async setModel(modelResourceId: string): Promise<void> {
		await this.emitAcked("session:set_model", { modelResourceId });
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.emitAcked("session:set_thinking_level", { level });
	}

	async invokeCommand(commandName: string, args?: string): Promise<void> {
		await this.emitAcked("session:invoke_command", { commandName, args });
	}

	async getSessionSources(): Promise<SourceRuntimeStatus[]> {
		const socket = this.requireSocket();
		return new Promise((resolve, reject) => {
			socket.emit("session:get_sources", {}, (ack: SessionGetSourcesAck) => {
				if (ack.ok) {
					resolve(ack.sources);
					return;
				}
				reject(new Error(ack.error));
			});
		});
	}

	async pauseSource(resourceId: string): Promise<SourceRuntimeStatus[]> {
		return this.emitMutateSource("session:pause_source", { resourceId });
	}

	async restartSource(resourceId: string): Promise<SourceRuntimeStatus[]> {
		return this.emitMutateSource("session:restart_source", { resourceId });
	}

	async removeSource(resourceId: string): Promise<SourceRuntimeStatus[]> {
		return this.emitMutateSource("session:remove_source", { resourceId });
	}

	async getMcpServers(): Promise<{ servers: McpRuntimeStatus[]; configError?: string }> {
		const socket = this.requireSocket();
		return new Promise((resolve, reject) => {
			socket.emit("session:get_mcp_servers", {}, (ack: SessionGetMcpServersAck) => {
				if (ack.ok) {
					if (ack.configError !== undefined) {
						resolve({ servers: ack.servers, configError: ack.configError });
					} else {
						resolve({ servers: ack.servers });
					}
					return;
				}
				reject(new Error(ack.error));
			});
		});
	}

	async getSkills(): Promise<Extract<SessionGetSkillsAck, { ok: true }>> {
		const socket = this.requireSocket();
		return new Promise((resolve, reject) => {
			socket.emit("session:get_skills", {}, (ack: SessionGetSkillsAck) => {
				if (ack.ok) {
					resolve(ack);
					return;
				}
				reject(new Error(ack.error));
			});
		});
	}

	async pauseMcpServer(resourceId: string): Promise<McpRuntimeStatus[]> {
		return this.emitMutateMcpServer("session:pause_mcp_server", { resourceId });
	}

	async restartMcpServer(resourceId: string): Promise<McpRuntimeStatus[]> {
		return this.emitMutateMcpServer("session:restart_mcp_server", { resourceId });
	}

	async removeMcpServer(resourceId: string): Promise<McpRuntimeStatus[]> {
		return this.emitMutateMcpServer("session:remove_mcp_server", { resourceId });
	}

	private installEventHandlers(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
		socket.on("hub:welcome", (payload) => {
			if (payload.protocolVersion !== this.options.hello.protocolVersion) {
				this.options.uiState.setConnectionStatus({
					state: "error",
					message: `Protocol version mismatch: peer=${this.options.hello.protocolVersion}, hub=${payload.protocolVersion}`,
				});
				socket.disconnect();
				return;
			}
			this.clearPendingCrdtSyncMessages();
			this.options.appState.applyWelcome(payload);
			this.options.uiState.setCrdtResyncing(false);
		});

		socket.on("session:crdt_sync", (payload) => {
			const message = toUint8Array(payload.message);
			this.enqueueCrdtSyncMessage(socket, message, payload.format);
		});

		socket.on("guest:agent_message", async (payload) => {
			await this.options.onGuestAgentMessage?.(payload);
		});

		socket.on("disconnect", (reason) => {
			this.clearPendingCrdtSyncMessages();
			this.clearImageGetTransportState();
			if (reason === "io client disconnect" || this.manualDisconnect) {
				this.options.uiState.setConnectionStatus({
					state: "disconnected",
					message: "Disconnected from hub.",
				});
				return;
			}
			this.options.uiState.setConnectionStatus({
				state: "reconnecting",
				message: `Connection lost (${reason}). Socket.IO reconnecting.`,
			});
		});

		socket.io.on("reconnect_attempt", (attempt) => {
			if (this.manualDisconnect) {
				return;
			}
			this.options.uiState.setConnectionStatus({
				state: "reconnecting",
				message: `Socket.IO reconnecting (attempt ${attempt})...`,
			});
		});

		socket.io.on("reconnect_error", (error) => {
			if (this.manualDisconnect) {
				return;
			}
			this.options.uiState.setConnectionStatus({
				state: "reconnecting",
				message: `Socket.IO reconnecting after error: ${error.message}`,
			});
		});

		socket.io.on("reconnect_failed", () => {
			if (this.manualDisconnect) {
				return;
			}
			this.options.uiState.setConnectionStatus({
				state: "error",
				message: "Socket.IO reconnect failed.",
			});
		});

		socket.on("tool:call_request", async (payload) => {
			try {
				if (this.options.onToolCallRequest) {
					await this.options.onToolCallRequest(payload, socket);
					return;
				}
				socket.emit("tool:call_error", {
					toolCallId: payload.toolCallId,
					message: `Peer tool execution is not implemented for tool "${payload.toolName}" yet.`,
				});
			} catch (error) {
				socket.emit("tool:call_error", {
					toolCallId: payload.toolCallId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	private enqueueCrdtSyncMessage(
		socket: Socket<ServerToClientEvents, ClientToServerEvents>,
		message: Uint8Array,
		format: SessionCrdtSyncPayload["format"],
	): void {
		this.pendingCrdtSyncMessages.push({ message, format });
		this.scheduleCrdtSyncDrain(socket);
	}

	private scheduleCrdtSyncDrain(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
		if (this.scheduledCrdtSyncDrain) {
			return;
		}
		const drain = (): void => {
			this.scheduledCrdtSyncDrain = undefined;
			this.drainNextCrdtSyncMessage(socket);
		};
		const handle = setTimeout(drain, 0);
		handle.unref?.();
		this.scheduledCrdtSyncDrain = { handle };
	}

	private drainNextCrdtSyncMessage(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
		if (this.socket !== socket || !socket.connected) {
			this.clearPendingCrdtSyncMessages();
			return;
		}
		const item = this.pendingCrdtSyncMessages.shift();
		if (!item) {
			return;
		}
		const { message, format } = item;
		let result: ReturnType<PeerAppState["applyCrdtSyncMessage"]>;
		try {
			result = this.options.appState.applyCrdtSyncMessage(message, format);
		} catch {
			this.clearPendingCrdtSyncMessages();
			this.options.appState.resetCrdtSyncState();
			this.options.uiState.setCrdtResyncing(true);
			socket.emit("session:crdt_resync_request");
			return;
		}
		this.options.uiState.setCrdtResyncing(false);
		if (this.options.appState.getSnapshot().selectedAgent?.status.isRunning === false) {
			this.options.uiState.setCancelling(false);
		}
		if (this.options.uiState.getSnapshot().connectionState !== "connected") {
			this.options.uiState.setConnectionStatus({
				state: "connected",
				message: "Connected to hub and synchronized the latest session state.",
			});
		}
		this.requestMissingImages(socket, result.missingImageIds);
		this.resolveInitialCrdtSyncWaiters();
		if (this.pendingCrdtSyncMessages.length === 0) {
			return;
		}
		this.scheduleCrdtSyncDrain(socket);
	}

	private resolveInitialCrdtSyncWaiters(): void {
		this.initialCrdtSynced = true;
		for (const resolve of this.initialCrdtSyncWaiters) {
			resolve();
		}
		this.initialCrdtSyncWaiters.clear();
	}

	private logHandshake(message: string): void {
		this.options.onHandshakeLog?.(message);
	}

	private clearPendingCrdtSyncMessages(): void {
		this.pendingCrdtSyncMessages.length = 0;
		if (this.scheduledCrdtSyncDrain) {
			clearTimeout(this.scheduledCrdtSyncDrain.handle);
			this.scheduledCrdtSyncDrain = undefined;
		}
	}

	/** In-flight and deferred image resource keys only; does not clear `PeerAppState` image cache. */
	private clearImageGetTransportState(): void {
		this.inFlightImageGetIds.clear();
		this.deferredImageGetIds.clear();
		this.failedImageGetIds.clear();
	}

	private requestMissingImages(socket: Socket<ServerToClientEvents, ClientToServerEvents>, imageIds: string[]): void {
		if (imageIds.length === 0) {
			return;
		}
		const cache = this.options.appState.getImageCache();
		const seen = new Set<string>();
		for (const imageId of imageIds) {
			if (seen.has(imageId)) {
				continue;
			}
			seen.add(imageId);
			if (cache.get(imageId)) {
				continue;
			}
			if (this.failedImageGetIds.has(imageId)) {
				continue;
			}
			if (this.inFlightImageGetIds.has(imageId)) {
				this.deferredImageGetIds.add(imageId);
				continue;
			}
			this.inFlightImageGetIds.add(imageId);
			void this.fetchImageResource(imageId)
				.then((image) => {
					if (this.socket !== socket) {
						return;
					}
					this.failedImageGetIds.delete(imageId);
					this.options.appState.applyImagePayload(image);
				})
				.catch(() => {
					if (this.socket === socket) {
						this.failedImageGetIds.add(imageId);
					}
				})
				.finally(() => {
					if (this.socket !== socket) {
						this.inFlightImageGetIds.delete(imageId);
						return;
					}
					this.inFlightImageGetIds.delete(imageId);
					const retryIds = Array.from(this.deferredImageGetIds);
					this.deferredImageGetIds.clear();
					if (retryIds.length > 0) {
						this.requestMissingImages(socket, retryIds);
					}
				});
		}
	}

	private async fetchImageResource(imageId: string): Promise<ImagePayload> {
		const url = new URL(`/resources/images/${encodeURIComponent(imageId)}`, this.options.hubUrl);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Image resource ${imageId} returned HTTP ${response.status}.`);
		}
		const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
		const data = Buffer.from(await response.arrayBuffer()).toString("base64");
		return { imageId, mimeType, data };
	}

	private async emitAcked<TEvent extends keyof AckedEventPayloads>(
		eventName: TEvent,
		payload: AckedEventPayloads[TEvent],
	): Promise<void> {
		const socket = this.requireSocket();
		await new Promise<void>((resolve, reject) => {
			const emit = socket.emit.bind(socket) as (
				event: string,
				payload: unknown,
				ack: (response: ActionAck) => void,
			) => void;
			emit(eventName, payload, (ack: ActionAck) => {
				if (ack.ok) {
					resolve();
					return;
				}
				reject(new Error(ack.error));
			});
		});
	}

	private async emitMutateSource(
		eventName: "session:pause_source" | "session:restart_source" | "session:remove_source",
		payload: { resourceId: string },
	): Promise<SourceRuntimeStatus[]> {
		const socket = this.requireSocket();
		return new Promise((resolve, reject) => {
			const emit = socket.emit.bind(socket) as (
				event: string,
				payload: unknown,
				ack: (response: SessionMutateSourceAck) => void,
			) => void;
			emit(eventName, payload, (ack: SessionMutateSourceAck) => {
				if (ack.ok) {
					resolve(ack.sources);
					return;
				}
				reject(new Error(ack.error));
			});
		});
	}

	private async emitMutateMcpServer(
		eventName: "session:pause_mcp_server" | "session:restart_mcp_server" | "session:remove_mcp_server",
		payload: { resourceId: string },
	): Promise<McpRuntimeStatus[]> {
		const socket = this.requireSocket();
		return new Promise((resolve, reject) => {
			const emit = socket.emit.bind(socket) as (
				event: string,
				payload: unknown,
				ack: (response: SessionMutateMcpServerAck) => void,
			) => void;
			emit(eventName, payload, (ack: SessionMutateMcpServerAck) => {
				if (ack.ok) {
					resolve(ack.servers);
					return;
				}
				reject(new Error(ack.error));
			});
		});
	}

	private requireSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
		if (!this.socket) {
			throw new Error("Peer client is not connected.");
		}
		return this.socket;
	}
}
