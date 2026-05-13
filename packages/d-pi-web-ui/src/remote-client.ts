import * as Automerge from "@automerge/automerge";
import { io } from "socket.io-client";
import type { HubAgentViewModel, HubViewDocumentState } from "./d-pi-hub.js";
import {
	type ActionAck,
	HUB_PROTOCOL_VERSION,
	type HubWelcomePayload,
	type PeerHelloAck,
	type SessionCrdtSyncPayload,
} from "./d-pi-hub-protocol.js";

const ROOT_AGENT_ID = "root";
const WEB_UI_VERSION = "0.1.0";

export type DPiWebConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface DPiWebClientSnapshot {
	connectionState: DPiWebConnectionState;
	agentId: string;
	error?: string;
	welcome?: HubWelcomePayload;
	view: Automerge.Doc<HubViewDocumentState>;
	agent?: HubAgentViewModel;
}

export type DPiWebClientListener = (snapshot: DPiWebClientSnapshot) => void;
type SocketAck = PeerHelloAck | ActionAck;

export interface DPiWebSocketLike {
	on(event: string, listener: (payload?: unknown) => void): DPiWebSocketLike;
	emit(event: string, payload: unknown, ack?: (response: SocketAck) => void): DPiWebSocketLike;
	disconnect(): void;
}

export type DPiWebSocketFactory = (url: string) => DPiWebSocketLike;

export interface DPiWebClientOptions {
	url?: string;
	agentId?: string;
	peerId?: string;
	displayName?: string;
	token?: string;
	socketFactory?: DPiWebSocketFactory;
}

export class DPiWebClient {
	private socket: DPiWebSocketLike | undefined;
	private readonly listeners = new Set<DPiWebClientListener>();
	private doc: Automerge.Doc<HubViewDocumentState> = Automerge.init();
	private connectionState: DPiWebConnectionState = "disconnected";
	private error: string | undefined;
	private welcome: HubWelcomePayload | undefined;
	private agentId = normalizeAgentId(this.options.agentId);
	private readonly hasExplicitAgentId = hasExplicitAgentId(this.options.agentId);

	constructor(private readonly options: DPiWebClientOptions = {}) {}

	get snapshot(): DPiWebClientSnapshot {
		const agentId = this.agentId;
		const agent = this.doc.agentsById?.[agentId];
		return {
			connectionState: this.connectionState,
			agentId,
			...(this.error === undefined ? {} : { error: this.error }),
			...(this.welcome === undefined ? {} : { welcome: this.welcome }),
			view: this.doc,
			...(agent === undefined ? {} : { agent }),
		};
	}

	subscribe(listener: DPiWebClientListener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	connect(): Promise<void> {
		if (this.socket) {
			return Promise.resolve();
		}
		this.setConnectionState("connecting");
		const socket = this.createSocket();
		this.socket = socket;
		socket.on("hub:welcome", (payload) => {
			const welcome = payload as HubWelcomePayload;
			this.welcome = welcome;
			if (!this.hasExplicitAgentId) {
				this.agentId = normalizeAgentId(welcome.agentId);
			}
			this.emitChange();
		});
		socket.on("session:crdt_sync", (payload) => {
			try {
				this.applyCrdtSync(payload as SessionCrdtSyncPayload);
			} catch (error) {
				this.doc = Automerge.init();
				this.error = error instanceof Error ? error.message : String(error);
				this.socket?.emit("session:crdt_resync_request", undefined);
				this.emitChange();
			}
		});
		socket.on("disconnect", (reason) => {
			this.error = formatDisconnectReason(reason);
			this.setConnectionState("disconnected");
		});

		return new Promise<void>((resolve, reject) => {
			socket.on("connect_error", (payload) => {
				const error = payload instanceof Error ? payload : new Error("连接 D-Pi 枢纽失败。");
				this.error = error.message;
				this.setConnectionState("error");
				reject(error);
			});
			socket.on("connect", () => {
				const helloPayload = {
					peerId: this.options.peerId ?? createPeerId(),
					...(this.hasExplicitAgentId ? { agentId: this.agentId } : {}),
					token: this.options.token ?? "",
					clientKind: "host" as const,
					protocolVersion: HUB_PROTOCOL_VERSION,
					displayName: this.options.displayName ?? "网页控制台",
					version: WEB_UI_VERSION,
					platform: "web",
					hostname: globalThis.location?.hostname,
					tools: [],
				};
				socket.emit("peer:hello", helloPayload, (ack) => {
					if (!ack.ok) {
						const error = new Error(ack.error);
						this.error = ack.error;
						this.setConnectionState("error");
						this.socket?.disconnect();
						this.socket = undefined;
						reject(error);
						return;
					}
					this.error = undefined;
					this.setConnectionState("connected");
					resolve();
				});
			});
		});
	}

	async sendMessage(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		await this.emitAction("session:queue_write", { text: trimmed });
		await this.emitAction("session:queue_flush", {});
	}

	async abort(): Promise<void> {
		await this.emitAction("session:abort", {});
	}

	disconnect(): void {
		this.socket?.disconnect();
		this.socket = undefined;
		this.welcome = undefined;
		this.doc = Automerge.init();
		this.setConnectionState("disconnected");
	}

	private createSocket(): DPiWebSocketLike {
		const url = this.options.url ?? globalThis.location?.origin ?? "http://127.0.0.1:4317";
		const factory = this.options.socketFactory ?? defaultSocketFactory;
		return factory(url);
	}

	private applyCrdtSync(payload: SessionCrdtSyncPayload): void {
		const message = toUint8Array(payload.message);
		if (payload.format === "snapshot") {
			this.doc = Automerge.load<HubViewDocumentState>(message);
			this.emitChange();
			return;
		}
		if (payload.format === "incremental") {
			this.doc = Automerge.loadIncremental(this.doc, message);
			this.emitChange();
			return;
		}
		const [nextDoc] = Automerge.receiveSyncMessage(this.doc, Automerge.initSyncState(), message);
		this.doc = nextDoc;
		this.emitChange();
	}

	private emitAction<TEvent extends "session:queue_write" | "session:queue_flush" | "session:abort">(
		event: TEvent,
		payload: unknown,
	): Promise<void> {
		const socket = this.socket;
		if (!socket) {
			return Promise.reject(new Error("网页控制台尚未连接到 D-Pi 枢纽。"));
		}
		return new Promise<void>((resolve, reject) => {
			socket.emit(event, payload, (ack) => {
				if (ack.ok) {
					resolve();
					return;
				}
				this.error = ack.error;
				this.emitChange();
				reject(new Error(ack.error));
			});
		});
	}

	private setConnectionState(state: DPiWebConnectionState): void {
		this.connectionState = state;
		this.emitChange();
	}

	private emitChange(): void {
		const snapshot = this.snapshot;
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

function defaultSocketFactory(url: string): DPiWebSocketLike {
	return io(url, {
		transports: ["websocket"],
		autoConnect: true,
	}) as unknown as DPiWebSocketLike;
}

function formatDisconnectReason(reason: unknown): string {
	if (typeof reason !== "string") {
		return "已断开连接。";
	}
	switch (reason) {
		case "io server disconnect":
			return "服务端已断开连接。";
		case "io client disconnect":
			return "客户端已断开连接。";
		case "ping timeout":
			return "连接心跳超时。";
		case "transport close":
			return "传输连接已关闭。";
		case "transport error":
			return "传输连接异常。";
		default:
			return `已断开连接：${reason}`;
	}
}

function createPeerId(): string {
	return `web-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function resolveAgentIdFromPath(pathname: string | undefined): string {
	if (!pathname) {
		return ROOT_AGENT_ID;
	}
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length === 2 && parts[0] === "agents") {
		try {
			return normalizeAgentId(decodeURIComponent(parts[1]));
		} catch {
			return normalizeAgentId(parts[1]);
		}
	}
	return ROOT_AGENT_ID;
}

export function readBrowserToken(): string {
	const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("token")?.trim();
	if (fromUrl) {
		return fromUrl;
	}
	try {
		return globalThis.localStorage?.getItem("d-pi.token")?.trim() ?? "";
	} catch {
		return "";
	}
}

export function saveBrowserToken(token: string): void {
	try {
		globalThis.localStorage?.setItem("d-pi.token", token);
	} catch {
		// Storage may be unavailable; the in-memory token remains usable for this session.
	}
}

export function clearBrowserToken(): void {
	try {
		globalThis.localStorage?.removeItem("d-pi.token");
	} catch {
		// Ignore storage failures.
	}
}

export function resolveDefaultAgentIdFromWelcome(welcome: HubWelcomePayload | undefined): string {
	return normalizeAgentId(welcome?.identity.createdByAgentId ?? welcome?.scopeRootAgentId ?? welcome?.agentId);
}

function normalizeAgentId(agentId: string | undefined): string {
	const trimmed = agentId?.trim();
	return trimmed && trimmed !== "main" ? trimmed : ROOT_AGENT_ID;
}

function hasExplicitAgentId(agentId: string | undefined): boolean {
	return typeof agentId === "string" && agentId.trim().length > 0;
}

function toUint8Array(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (Array.isArray(value)) {
		return new Uint8Array(value);
	}
	throw new Error("无效的 CRDT 同步载荷。");
}
