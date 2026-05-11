import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Server, type Socket } from "socket.io";
import { D_PI_WEB_UI_DIST_DIR } from "../../runtime/bundle-env.js";
import type { HubAgentAdapter } from "../agent/hub-agent-adapter.js";
import { ROOT_AGENT_ID } from "../agents/types.js";
import type { HubAuthIdentity } from "../auth/token-store.js";
import { VERSION } from "../config.js";
import type { PeerConfigSnapshot } from "../config-aggregation/types.js";
import type { McpRuntimeStatus } from "../mcp/types.js";
import type { PeerRegistry } from "../peers/peer-registry.js";
import type { PeerMcpSnapshot, RegisteredPeer } from "../peers/peer-types.js";
import type { HubSessionService } from "../session/hub-session-service.js";
import { HubViewDocument, type HubViewProjectionState } from "../session/hub-view-document.js";
import type { HubSessionEvent } from "../session/session-events.js";
import type { HubSessionSnapshot } from "../session/session-snapshot.js";
import type { SourceRuntimeStatus } from "../sources/source-types.js";
import type { HubLogDetails, HubLogSink } from "../tui/hub-log.js";
import { type ImagePayload, ImagePayloadCache, type MaterializedPeerPayload } from "./image-payload-cache.js";
import type {
	ActionAck,
	ClientToServerEvents,
	LiveRenderEvent,
	PublicOrgSnapshot,
	ServerToClientEvents,
	SessionGetMcpServersAck,
	SessionGetSkillsAck,
	SessionGetSourcesAck,
	SessionInvokeCommandPayload,
	SessionMutateMcpServerAck,
	SessionMutateSourceAck,
	SessionSetModelPayload,
	SessionSetThinkingLevelPayload,
	SourceMessagePayload,
	ToolCallAckPayload,
	ToolCallErrorPayload,
	ToolCallRequestPayload,
	ToolCallResultPayload,
	ToolCallUpdatePayload,
} from "./protocol.js";
import { HUB_PROTOCOL_VERSION } from "./protocol.js";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const PEER_NOT_REGISTERED_MESSAGE = "Peer is not registered.";
const SOCKET_ALREADY_HELLO = "This socket is already bound to a hub agent; peer:hello is one-shot.";
const MAX_SOCKETIO_PACKET_BYTES = 8 * 1024 * 1024;
const SOCKET_SNAPSHOT_LOG_PAYLOAD_BYTES = 256 * 1024;
const SOCKET_SNAPSHOT_LOG_DURATION_MS = 10;
const SOCKET_COMPRESSION_MIN_BYTES = 32 * 1024;
const INITIAL_CRDT_SYNC_DEBOUNCE_MS = 750;
const LIVE_CRDT_FANOUT_DEBOUNCE_MS = 33;
const SESSION_CRDT_FANOUT_DEBOUNCE_MS = 10;
const IDLE_CRDT_COMPACT_CHANGE_THRESHOLD = 20_000;
const ACTIVE_CRDT_COMPACT_CHANGE_THRESHOLD = 80_000;
const CRDT_COMPACT_THROTTLE_MS = 500;
const SOCKET_PING_INTERVAL_MS = 10_000;
const SOCKET_PING_TIMEOUT_MS = 300_000;
const DEFAULT_WEB_UI_DIST_DIR = D_PI_WEB_UI_DIST_DIR;
const HOST_CLIENT_PEER_ID = "host";

export function shouldCompressCrdtPayload(byteLength: number): boolean {
	return byteLength >= SOCKET_COMPRESSION_MIN_BYTES;
}

function getQueueWriteSentAt(payload: unknown): string {
	if (payload && typeof payload === "object" && "sentAt" in payload) {
		const sentAt = (payload as { sentAt?: unknown }).sentAt;
		if (typeof sentAt === "string" && Number.isFinite(Date.parse(sentAt))) {
			return sentAt;
		}
	}
	return new Date().toISOString();
}

function getAuthMessageSourceMetadata(identity: HubAuthIdentity | undefined) {
	if (!identity) {
		return {};
	}
	return {
		authTokenName: identity.name,
		authTokenDescription: identity.description,
		authUser: identity.user,
		authPurpose: identity.purpose,
	};
}

type SocketClientKind = "peer" | "host";

function getDefaultHostAgentIdForIdentity(identity: HubAuthIdentity): string {
	return identity.createdByAgentId || identity.scopeRootAgentId || ROOT_AGENT_ID;
}

interface SocketFanoutStats {
	eventCount: number;
	payloadTotalBytes: number;
	payloadMaxBytes: number;
}

type PendingCrdtFanout = {
	timer?: ReturnType<typeof setTimeout>;
	eventCount: number;
	reason: "session" | "live";
	startedAt: number;
};
/**
 * Per-agent view of what the transport needs from `HubAgentRuntime` (keeps `socket-hub` free of
 * a runtime import cycle with `HubAgentRuntime` importing this module).
 */
export interface HubAgentSocketBinding {
	sessionService: HubSessionService;
	peerRegistry: PeerRegistry;
	tools: ToolDefinition[];
	agentAdapter: HubAgentAdapter | undefined;
}

export interface HubAgentSocketMetadata {
	parentId?: string;
	kind?: "root" | "child";
	lifecycle?: "persistent" | "temporary";
	name?: string;
	description?: string;
}

export interface SocketHubServerSourceMutators {
	pause: (name: string) => Promise<void>;
	restart: (name: string) => Promise<void>;
	remove: (name: string) => Promise<void>;
}

const DEFAULT_SOURCE_MUTATORS: SocketHubServerSourceMutators = {
	pause: async () => undefined,
	restart: async () => undefined,
	remove: async () => undefined,
};

export interface SocketHubServerMcpMutators {
	pauseServer: (agentId: string, name: string) => Promise<SessionMutateMcpServerAck>;
	restartServer: (agentId: string, name: string) => Promise<SessionMutateMcpServerAck>;
	removeServer: (agentId: string, name: string) => Promise<SessionMutateMcpServerAck>;
}

export interface SocketHubServerCrdtCompactThresholds {
	idleChangeCount: number;
	activeChangeCount: number;
}

const DEFAULT_CRDT_COMPACT_THRESHOLDS: SocketHubServerCrdtCompactThresholds = {
	idleChangeCount: IDLE_CRDT_COMPACT_CHANGE_THRESHOLD,
	activeChangeCount: ACTIVE_CRDT_COMPACT_CHANGE_THRESHOLD,
};

const DEFAULT_MCP_MUTATORS: SocketHubServerMcpMutators = {
	pauseServer: async () => ({ ok: false, error: "MCP server control is not available on this hub." }),
	restartServer: async () => ({ ok: false, error: "MCP server control is not available on this hub." }),
	removeServer: async () => ({ ok: false, error: "MCP server control is not available on this hub." }),
};

function mcpServerResourceIdOrAckFailure(
	resourceIdRaw: unknown,
	ack: (response: SessionMutateMcpServerAck) => void,
): string | undefined {
	if (typeof resourceIdRaw !== "string" || !resourceIdRaw.trim()) {
		ack({ ok: false, error: "MCP server resourceId is required." });
		return undefined;
	}
	return resourceIdRaw.trim();
}

function serveWebUiStaticRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	webUiDistDir: string,
): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return false;
	}
	if (!existsSync(webUiDistDir)) {
		return false;
	}
	const requestPath = url.pathname;
	const isAgentUiRequest = /^\/agents\/[^/]+\/?$/.test(requestPath);
	const isIndexRequest = requestPath === "/" || requestPath === "/index.html" || isAgentUiRequest;
	const isAssetRequest = requestPath.startsWith("/assets/");
	if (!isIndexRequest && !isAssetRequest) {
		return false;
	}
	const relativePath = isIndexRequest ? "index.html" : decodeStaticPath(requestPath.slice(1));
	if (!relativePath) {
		response.statusCode = 400;
		response.end();
		return true;
	}
	const root = resolve(webUiDistDir);
	const filePath = resolve(root, relativePath);
	if (!isPathInside(root, filePath)) {
		response.statusCode = 404;
		response.end();
		return true;
	}
	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		response.statusCode = 404;
		response.end();
		return true;
	}
	const body = readFileSync(filePath);
	response.statusCode = 200;
	response.setHeader("content-type", getStaticContentType(filePath));
	if (isAssetRequest) {
		response.setHeader("cache-control", "public, max-age=31536000, immutable");
	}
	if (request.method === "HEAD") {
		response.end();
		return true;
	}
	response.end(body);
	return true;
}

function servePublicOrgRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	getSnapshot: () => PublicOrgSnapshot,
): boolean {
	if (url.pathname !== "/api/public/org") {
		return false;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.statusCode = 405;
		response.setHeader("allow", "GET, HEAD");
		response.end();
		return true;
	}
	const body = JSON.stringify(getSnapshot());
	response.statusCode = 200;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.setHeader("x-content-type-options", "nosniff");
	if (request.method === "HEAD") {
		response.end();
		return true;
	}
	response.end(body);
	return true;
}

function createFallbackPublicOrgSnapshot(deps: SocketHubServerDeps): PublicOrgSnapshot {
	return {
		app: "d-pi hub",
		version: VERSION,
		protocolVersion: HUB_PROTOCOL_VERSION,
		generatedAt: new Date().toISOString(),
		agents: deps.getAgentIds().map((agentId) => {
			const runtime = deps.getAgentRuntime(agentId);
			const metadata = deps.getAgentMetadata?.(agentId);
			const snapshot = runtime?.sessionService.getSnapshot();
			const activationStatus = runtime?.agentAdapter ? "running" : "not_hydrated";
			return {
				id: agentId,
				...(metadata?.parentId === undefined ? {} : { parentId: metadata.parentId }),
				...(metadata?.kind === undefined ? {} : { kind: metadata.kind }),
				...(metadata?.lifecycle === undefined ? {} : { lifecycle: metadata.lifecycle }),
				...(metadata?.name === undefined ? {} : { name: metadata.name }),
				activationStatus,
				isRunning: snapshot?.isRunning ?? false,
				peerCount: runtime?.peerRegistry.size() ?? 0,
				hasError: Boolean(snapshot?.lastError),
			};
		}),
	};
}

function decodeStaticPath(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function isPathInside(root: string, filePath: string): boolean {
	return filePath === root || filePath.startsWith(`${root}${sep}`);
}

function getStaticContentType(filePath: string): string {
	switch (extname(filePath)) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

export interface SocketHubServerAddress {
	host: string;
	port: number;
}

export interface SocketHubServerOptions {
	host: string;
	port: number;
}

export interface SocketHubServerToolCallEvent<TPayload> {
	peer: RegisteredPeer;
	payload: TPayload;
}

export interface SocketHubServerDeps {
	getDefaultAgentId: () => string;
	getAgentIds: () => string[];
	getAgentRuntime: (agentId: string) => HubAgentSocketBinding | undefined;
	ensureAgentStarted?: (agentId: string) => Promise<HubAgentSocketBinding | undefined>;
	getAgentMetadata?: (agentId: string) => HubAgentSocketMetadata | undefined;
	getPublicOrgSnapshot?: () => PublicOrgSnapshot;
	authenticateToken: (token: string) => HubAuthIdentity | undefined | Promise<HubAuthIdentity | undefined>;
	isAgentInScope: (scopeRootAgentId: string, targetAgentId: string) => boolean;
	getHttpSessionService: () => HubSessionService;
	/** Subscribe to all agents' `HubSessionService` event streams and update the CRDT view model. */
	subscribeAllAgentSessionEvents: (onEvent: (agentId: string, event: HubSessionEvent) => void) => () => void;
	getSourceStatuses: (agentId: string) => SourceRuntimeStatus[];
	getSourceMessageTargetAgentIds?: (boundAgentId: string, sourceName: string, requestedAgentId?: string) => string[];
	sourceMutators: SocketHubServerSourceMutators;
	getMcpServerStatuses: (agentId: string) => McpRuntimeStatus[];
	getMcpConfigError: (agentId: string) => string | undefined;
	onPeerConfigSnapshot?: (agentId: string, peerId: string, snapshot: PeerConfigSnapshot) => void;
	onPeerConfigRemoved?: (agentId: string, peerId: string) => void;
	mcpMutators: SocketHubServerMcpMutators;
	crdtCompactThresholds?: SocketHubServerCrdtCompactThresholds;
	logs?: HubLogSink;
	webUiDistDir?: string;
}

export class SocketHubServer {
	private httpServer: HttpServer | undefined;
	private io: Server<ClientToServerEvents, ServerToClientEvents> | undefined;
	private address: SocketHubServerAddress | undefined;
	private readonly imagePayloadCache = new ImagePayloadCache();
	private readonly socketAgentIds = new Map<string, string>();
	private readonly socketIdentities = new Map<string, HubAuthIdentity>();
	private readonly socketClientKinds = new Map<string, SocketClientKind>();
	private readonly socketHostIds = new Map<string, string>();
	private readonly viewDocuments = new Map<string, HubViewDocument>();
	private readonly viewImagesByAgentId = new Map<string, ImagePayload[]>();
	private readonly crdtSyncStatesBySocketId = new Map<string, HubViewProjectionState>();
	private readonly initialCrdtSyncTimersBySocketId = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly pendingCrdtFanoutsByAgentId = new Map<string, PendingCrdtFanout>();
	/**
	 * Per-agent throttle so a burst of mutations only triggers one compaction check per
	 * {@link CRDT_COMPACT_THROTTLE_MS}. The check itself is O(1) (`view.getChangeCount()` is a
	 * cached counter), but `compactHistory()` rewrites Automerge state and is far more expensive,
	 * so we batch decisions instead of checking on every mutation.
	 */
	private readonly compactCheckTimersByAgentId = new Map<string, ReturnType<typeof setTimeout>>();
	private unsubscribeSessionEvents: (() => void) | undefined;
	private readonly toolCallAckListeners = new Set<(event: SocketHubServerToolCallEvent<ToolCallAckPayload>) => void>();
	private readonly toolCallUpdateListeners = new Set<
		(event: SocketHubServerToolCallEvent<ToolCallUpdatePayload>) => void
	>();
	private readonly toolCallResultListeners = new Set<
		(event: SocketHubServerToolCallEvent<ToolCallResultPayload>) => void
	>();
	private readonly toolCallErrorListeners = new Set<
		(event: SocketHubServerToolCallEvent<ToolCallErrorPayload>) => void
	>();

	constructor(private readonly deps: SocketHubServerDeps) {}

	private log(level: keyof HubLogSink, message: string, details?: string | HubLogDetails): void {
		try {
			this.deps.logs?.[level](message, details);
		} catch {
			// Logging is best-effort and must never break socket protocol handling.
		}
	}

	private logPeerMcpSnapshotErrors(agentId: string, peerId: string, snapshot: PeerMcpSnapshot | undefined): void {
		if (!snapshot) {
			return;
		}
		if (snapshot.configError) {
			this.log("warning", "peer mcp config error", {
				agentId,
				peerId,
				error: snapshot.configError,
			});
		}
		for (const server of snapshot.servers) {
			if (server.status !== "error" || !server.error) {
				continue;
			}
			this.log("error", "peer mcp server error", {
				agentId,
				peerId,
				mcpServer: server.name,
				resourceId: server.resourceId ?? null,
				transport: server.transport,
				error: server.error,
			});
		}
	}

	async start(options: SocketHubServerOptions): Promise<SocketHubServerAddress> {
		if (this.address) {
			return this.address;
		}

		this.viewDocuments.clear();
		this.viewImagesByAgentId.clear();
		this.initializeViewDocumentsForAgents([this.deps.getDefaultAgentId()]);

		const httpServer = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const imagePrefix = "/resources/images/";
			if (request.method === "GET" && url.pathname.startsWith(imagePrefix)) {
				const imageId = decodeURIComponent(url.pathname.slice(imagePrefix.length)).trim();
				if (!imageId) {
					response.statusCode = 404;
					response.end();
					return;
				}
				const image = this.imagePayloadCache.get(imageId);
				if (!image) {
					response.statusCode = 404;
					response.end();
					return;
				}
				const body = Buffer.from(image.data, "base64");
				response.statusCode = 200;
				response.setHeader("content-type", image.mimeType);
				response.setHeader("cache-control", "private, max-age=31536000, immutable");
				response.setHeader("etag", `"${image.imageId}"`);
				response.end(body);
				return;
			}

			if (
				servePublicOrgRequest(
					request,
					response,
					url,
					this.deps.getPublicOrgSnapshot ?? (() => createFallbackPublicOrgSnapshot(this.deps)),
				)
			) {
				return;
			}

			if (serveWebUiStaticRequest(request, response, url, this.deps.webUiDistDir ?? DEFAULT_WEB_UI_DIST_DIR)) {
				return;
			}

			const httpSession = this.deps.getHttpSessionService();
			const mainBinding = this.deps.getAgentRuntime(this.deps.getDefaultAgentId());
			const peerCount = mainBinding ? mainBinding.peerRegistry.size() : 0;
			response.statusCode = 200;
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(
				JSON.stringify({
					app: "d-pi hub",
					version: VERSION,
					protocolVersion: HUB_PROTOCOL_VERSION,
					sessionId: httpSession.getHeader().id,
					peers: peerCount,
				}),
			);
		});

		const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
			cors: { origin: "*" },
			httpCompression: false,
			maxHttpBufferSize: MAX_SOCKETIO_PACKET_BYTES,
			perMessageDeflate: false,
			pingInterval: SOCKET_PING_INTERVAL_MS,
			pingTimeout: SOCKET_PING_TIMEOUT_MS,
		});
		io.on("connection", (socket) => this.handleConnection(socket));
		this.unsubscribeSessionEvents = this.deps.subscribeAllAgentSessionEvents((agentId, event) => {
			this.emitSessionEventForAgent(agentId, event);
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			httpServer.once("error", onError);
			httpServer.listen(options.port, options.host, () => {
				httpServer.off("error", onError);
				resolve();
			});
		});

		const serverAddress = httpServer.address();
		if (!serverAddress || typeof serverAddress === "string") {
			throw new Error("Failed to resolve d-pi hub listen address.");
		}

		this.httpServer = httpServer;
		this.io = io;
		this.address = {
			host: serverAddress.address,
			port: serverAddress.port,
		};
		return this.address;
	}

	async stop(): Promise<void> {
		const io = this.io;
		const httpServer = this.httpServer;
		this.unsubscribeSessionEvents?.();
		this.unsubscribeSessionEvents = undefined;
		this.io = undefined;
		this.httpServer = undefined;
		this.address = undefined;
		this.socketAgentIds.clear();
		this.socketIdentities.clear();
		this.socketClientKinds.clear();
		this.socketHostIds.clear();
		this.crdtSyncStatesBySocketId.clear();
		for (const pending of this.pendingCrdtFanoutsByAgentId.values()) {
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
		}
		this.pendingCrdtFanoutsByAgentId.clear();
		for (const timer of this.compactCheckTimersByAgentId.values()) {
			clearTimeout(timer);
		}
		this.compactCheckTimersByAgentId.clear();

		if (io) {
			await new Promise<void>((resolve, reject) => {
				io.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			return;
		}

		if (httpServer) {
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	}

	disconnectAgentPeers(agentId: string): number {
		if (!this.io) {
			return 0;
		}
		let count = 0;
		for (const socket of this.io.sockets.sockets.values()) {
			if (this.socketAgentIds.get(socket.id) === agentId) {
				socket.disconnect(true);
				count += 1;
			}
		}
		return count;
	}

	disconnectToken(tokenId: string): number {
		if (!this.io) {
			return 0;
		}
		let count = 0;
		for (const socket of this.io.sockets.sockets.values()) {
			if (this.socketIdentities.get(socket.id)?.id === tokenId) {
				socket.disconnect(true);
				count += 1;
			}
		}
		return count;
	}

	initializeViewDocumentsForAgents(agentIds: string[]): void {
		for (const agentId of agentIds) {
			this.initializeViewDocumentForAgent(agentId, { syncAgentList: false });
		}
		this.syncAgentListToAllViewDocuments();
	}

	refreshAgentListViews(): void {
		this.syncAgentListToAllViewDocuments();
		if (this.io) {
			this.scheduleCrdtFanoutForAllAgents();
		}
	}

	initializeViewDocumentForAgent(agentId: string, options: { syncAgentList?: boolean } = {}): void {
		const startedAt = Date.now();
		const runtime = this.deps.getAgentRuntime(agentId);
		if (!runtime) {
			throw new Error(`Unknown agent id: ${agentId}`);
		}
		const materializeStartedAt = Date.now();
		const materialized: MaterializedPeerPayload<{ snapshot: HubSessionSnapshot }> =
			this.imagePayloadCache.materializePeerPayload({ snapshot: runtime.sessionService.getSnapshot() });
		const materializeMs = Date.now() - materializeStartedAt;
		const view = this.getViewDocument(agentId);
		view.resetSession(materialized.value.snapshot, agentId);
		this.updateAgentMetadataInView(agentId, view);
		this.rememberViewImages(agentId, materialized.images);
		this.log("info", "hub startup timing", {
			phase: "crdt_view",
			agentId,
			durationMs: Date.now() - startedAt,
			messages: materialized.value.snapshot.entries.length,
			materializeMs,
		});
		if (options.syncAgentList ?? true) {
			this.syncAgentListToAllViewDocuments();
		}
		if (this.io) {
			this.scheduleCrdtFanoutForAllAgents();
		}
	}

	private getBoundRuntime(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
	): HubAgentSocketBinding | undefined {
		const agentId = this.socketAgentIds.get(socket.id);
		if (agentId === undefined) {
			return undefined;
		}
		return this.deps.getAgentRuntime(agentId);
	}

	private handleConnection(socket: Socket<ClientToServerEvents, ServerToClientEvents>): void {
		socket.on("peer:hello", async (payload, ack) => {
			try {
				if (this.socketAgentIds.has(socket.id)) {
					ack({ ok: false, error: SOCKET_ALREADY_HELLO });
					return;
				}
				if (payload.protocolVersion !== HUB_PROTOCOL_VERSION) {
					ack({
						ok: false,
						error: `Protocol version mismatch: peer=${payload.protocolVersion}, hub=${HUB_PROTOCOL_VERSION}`,
					});
					return;
				}
				const requestedAgentId =
					typeof payload.agentId === "string" && payload.agentId.trim() ? payload.agentId.trim() : undefined;
				const clientKind: SocketClientKind = payload.clientKind === "host" ? "host" : "peer";
				if (typeof payload.token !== "string" || payload.token.trim().length === 0) {
					ack({ ok: false, error: "Authentication token is required." });
					return;
				}
				const identity = await Promise.resolve(this.deps.authenticateToken(payload.token));
				if (!identity) {
					ack({ ok: false, error: "Invalid authentication token." });
					return;
				}
				if (this.socketAgentIds.has(socket.id)) {
					ack({ ok: false, error: SOCKET_ALREADY_HELLO });
					return;
				}
				if (!socket.connected) {
					return;
				}
				const effective =
					requestedAgentId ??
					(clientKind === "host" ? getDefaultHostAgentIdForIdentity(identity) : this.deps.getDefaultAgentId());
				if (!this.deps.getAgentIds().includes(effective)) {
					ack({ ok: false, error: `Unknown agent id: ${effective}` });
					return;
				}
				if (!this.deps.isAgentInScope(identity.scopeRootAgentId, effective)) {
					ack({ ok: false, error: `Token scope does not allow access to agent id: ${effective}` });
					return;
				}
				const target = (await this.deps.ensureAgentStarted?.(effective)) ?? this.deps.getAgentRuntime(effective);
				if (!target) {
					ack({ ok: false, error: `Unknown agent id: ${effective}` });
					return;
				}
				if (!this.viewDocuments.has(effective)) {
					this.initializeViewDocumentForAgent(effective);
				}
				this.socketAgentIds.set(socket.id, effective);
				this.socketIdentities.set(socket.id, identity);
				this.socketClientKinds.set(socket.id, clientKind);
				if (clientKind === "host") {
					const hostId = payload.peerId.trim() || HOST_CLIENT_PEER_ID;
					this.socketHostIds.set(socket.id, hostId);
					ack({ ok: true });
					this.log("info", "host ui connected", { agentId: effective, peerId: hostId });
					socket.emit("hub:welcome", {
						sessionId: target.sessionService.getHeader().id,
						peerId: hostId,
						agentId: effective,
						clientKind,
						hubVersion: VERSION,
						protocolVersion: HUB_PROTOCOL_VERSION,
						toolNames: target.tools.map((tool) => tool.name),
						identity,
						scopeRootAgentId: identity.scopeRootAgentId,
					});
					this.resetCrdtSyncForSocket(effective, socket);
					return;
				}
				const { peer, replacedSocketId } = target.peerRegistry.register(socket.id, payload, effective);
				ack({ ok: true });
				this.log("info", "peer connected", { agentId: effective, peerId: peer.peerId });
				socket.emit("hub:welcome", {
					sessionId: target.sessionService.getHeader().id,
					peerId: peer.peerId,
					agentId: effective,
					clientKind,
					hubVersion: VERSION,
					protocolVersion: HUB_PROTOCOL_VERSION,
					toolNames: target.tools.map((tool) => tool.name),
					identity,
					scopeRootAgentId: identity.scopeRootAgentId,
				});

				if (replacedSocketId) {
					this.io?.sockets.sockets.get(replacedSocketId)?.disconnect(true);
					this.socketAgentIds.delete(replacedSocketId);
					this.socketIdentities.delete(replacedSocketId);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown peer registration error";
				ack({ ok: false, error: message });
			}
		});

		socket.on("peer:config", (payload, ack) => {
			try {
				const agentId = this.socketAgentIds.get(socket.id);
				const target = agentId ? this.deps.getAgentRuntime(agentId) : undefined;
				if (!agentId || !target) {
					ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
					return;
				}
				if (this.socketClientKinds.get(socket.id) !== "peer") {
					ack({ ok: false, error: "Only peer clients can upload peer config." });
					return;
				}
				const { peer } = target.peerRegistry.updateConfigBySocketId(socket.id, payload);
				if (payload.configSnapshot) {
					this.deps.onPeerConfigSnapshot?.(agentId, peer.peerId, payload.configSnapshot);
				}
				this.logPeerMcpSnapshotErrors(agentId, peer.peerId, payload.mcpSnapshot);
				ack({ ok: true });
				this.broadcastPeerListForAgent(agentId);
				this.resetCrdtSyncForSocket(agentId, socket);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown peer config error";
				ack({ ok: false, error: message });
			}
		});

		socket.on("session:queue_write", async (payload, ack) => {
			const client = this.registeredClientFromSocketForAction(socket, ack);
			if (!client) {
				return;
			}
			const text = typeof payload?.text === "string" ? payload.text.trim() : "";
			if (!text) {
				ack({ ok: false, error: "Queue write text is required." });
				return;
			}
			const metadata = {
				sentAt: getQueueWriteSentAt(payload),
				...getAuthMessageSourceMetadata(this.socketIdentities.get(socket.id)),
			};
			await this.handleSimpleAction(socket, client.bound, payload, ack, (adapter) => {
				if (client.clientKind === "host") {
					return adapter.enqueueFromHost(client.hostId, text, metadata);
				}
				return adapter.enqueueFromPeer(client.peer.peerId, text, metadata);
			});
		});

		socket.on("session:queue_flush", async (_payload, ack) => {
			const client = this.registeredClientFromSocketForAction(socket, ack);
			if (!client) {
				return;
			}
			const adapter = await this.getAdapterForSocketAction(socket, client.bound, ack);
			if (!adapter) {
				return;
			}
			ack({ ok: true });
			void adapter.flushInputQueue().catch((error) => {
				client.bound.sessionService.recordError(error instanceof Error ? error.message : String(error));
			});
		});

		socket.on("source:message", async (payload, ack) => {
			const reg = this.registeredPeerFromSocketForAction(socket, ack);
			if (!reg) {
				return;
			}
			await this.handleSourceMessage(reg, payload, ack);
		});

		socket.on("session:abort", async (_payload, ack) => {
			const client = this.registeredClientFromSocketForAction(socket, ack);
			if (!client) {
				return;
			}
			const adapter = await this.getAdapterForSocketAction(socket, client.bound, ack);
			if (!adapter) {
				return;
			}
			ack({ ok: true });
			void adapter.abort().catch((error) => {
				client.bound.sessionService.recordError(error instanceof Error ? error.message : String(error));
			});
		});

		socket.on("session:set_model", async (payload, ack) => {
			const client = this.registeredClientFromSocketForAction(socket, ack);
			if (!client) {
				return;
			}
			await this.handleSetModel(socket, client.bound, payload, ack);
		});

		socket.on("session:set_thinking_level", async (payload, ack) => {
			const client = this.registeredClientFromSocketForAction(socket, ack);
			if (!client) {
				return;
			}
			await this.handleSetThinkingLevel(socket, client.bound, payload, ack);
		});

		socket.on("session:invoke_command", async (payload, ack) => {
			const client = this.registeredClientFromSocketForAction(socket, ack);
			if (!client) {
				return;
			}
			await this.handleInvokeCommand(socket, client.bound, payload, ack);
		});

		socket.on("session:get_sources", (_payload, ack) => {
			const peer = this.registeredPeerFromSocketForSources(socket, ack);
			if (!peer) {
				return;
			}
			try {
				const sources = this.deps.getSourceStatuses(peer.agentId);
				const response: SessionGetSourcesAck = { ok: true, sources };
				ack(response);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ack({ ok: false, error: message });
			}
		});

		socket.on("session:pause_source", async (payload, ack) => {
			const peer = this.registeredPeerFromSocketForSourceMutate(socket, ack);
			if (!peer) {
				return;
			}
			try {
				await this.deps.sourceMutators.pause(payload.resourceId);
				ack({ ok: true, sources: this.deps.getSourceStatuses(peer.agentId) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ack({ ok: false, error: message });
			}
		});

		socket.on("session:restart_source", async (payload, ack) => {
			const peer = this.registeredPeerFromSocketForSourceMutate(socket, ack);
			if (!peer) {
				return;
			}
			try {
				await this.deps.sourceMutators.restart(payload.resourceId);
				ack({ ok: true, sources: this.deps.getSourceStatuses(peer.agentId) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ack({ ok: false, error: message });
			}
		});

		socket.on("session:remove_source", async (payload, ack) => {
			const peer = this.registeredPeerFromSocketForSourceMutate(socket, ack);
			if (!peer) {
				return;
			}
			try {
				await this.deps.sourceMutators.remove(payload.resourceId);
				ack({ ok: true, sources: this.deps.getSourceStatuses(peer.agentId) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ack({ ok: false, error: message });
			}
		});

		socket.on("session:get_mcp_servers", (_payload, ack) => {
			const peer = this.registeredPeerFromSocketForMcpGet(socket, ack);
			if (!peer) {
				return;
			}
			try {
				const servers = this.deps.getMcpServerStatuses(peer.agentId);
				const configError = this.deps.getMcpConfigError(peer.agentId);
				if (configError !== undefined) {
					const response: SessionGetMcpServersAck = { ok: true, servers, configError };
					ack(response);
				} else {
					ack({ ok: true, servers });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ack({ ok: false, error: message });
			}
		});

		socket.on("session:get_skills", (_payload, ack) => {
			const reg = this.registeredPeerFromSocketForSkillGet(socket, ack);
			if (!reg) {
				return;
			}
			const adapter = reg.bound.agentAdapter;
			if (!adapter) {
				ack({ ok: false, error: "Hub agent adapter is not initialized." });
				return;
			}
			try {
				const result = adapter.resourceLoader.getSkills();
				const response: SessionGetSkillsAck = {
					ok: true,
					skills: result.skills.map((skill) => ({
						name: skill.name,
						description: skill.description,
						filePath: skill.filePath,
						sourceInfo: skill.sourceInfo,
						disableModelInvocation: skill.disableModelInvocation,
					})),
					diagnostics: result.diagnostics.map((diagnostic) => ({
						type: diagnostic.type,
						message: diagnostic.message,
						path: diagnostic.path,
					})),
				};
				ack(response);
			} catch (error) {
				ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		});

		socket.on("session:pause_mcp_server", async (payload, ack) => {
			const peer = this.registeredPeerFromSocketForMcpMutate(socket, ack);
			if (!peer) {
				return;
			}
			const resourceId = mcpServerResourceIdOrAckFailure(payload.resourceId, ack);
			if (resourceId === undefined) {
				return;
			}
			const result = await this.deps.mcpMutators.pauseServer(peer.agentId, resourceId);
			ack(result);
		});

		socket.on("session:restart_mcp_server", async (payload, ack) => {
			const peer = this.registeredPeerFromSocketForMcpMutate(socket, ack);
			if (!peer) {
				return;
			}
			const resourceId = mcpServerResourceIdOrAckFailure(payload.resourceId, ack);
			if (resourceId === undefined) {
				return;
			}
			const result = await this.deps.mcpMutators.restartServer(peer.agentId, resourceId);
			ack(result);
		});

		socket.on("session:remove_mcp_server", async (payload, ack) => {
			const peer = this.registeredPeerFromSocketForMcpMutate(socket, ack);
			if (!peer) {
				return;
			}
			const resourceId = mcpServerResourceIdOrAckFailure(payload.resourceId, ack);
			if (resourceId === undefined) {
				return;
			}
			const result = await this.deps.mcpMutators.removeServer(peer.agentId, resourceId);
			ack(result);
		});

		socket.on("tool:call_ack", (payload) => {
			const reg = this.resolveToolCallPeerForSocket(socket);
			if (reg) {
				this.emitToolCallAck({ peer: reg.peer, payload });
			}
		});

		socket.on("tool:call_update", (payload) => {
			const reg = this.resolveToolCallPeerForSocket(socket);
			if (reg) {
				this.emitToolCallUpdate({ peer: reg.peer, payload });
			}
		});

		socket.on("tool:call_result", (payload) => {
			const reg = this.resolveToolCallPeerForSocket(socket);
			if (reg) {
				this.emitToolCallResult({ peer: reg.peer, payload });
			}
		});

		socket.on("tool:call_error", (payload) => {
			const reg = this.resolveToolCallPeerForSocket(socket);
			if (reg) {
				this.emitToolCallError({ peer: reg.peer, payload });
			}
		});

		socket.on("session:crdt_sync", (payload) => {
			const agentId = this.socketAgentIds.get(socket.id);
			if (!agentId) {
				return;
			}
			const view = this.viewDocuments.get(agentId);
			if (!view || !this.crdtSyncStatesBySocketId.has(socket.id)) {
				return;
			}
			try {
				if (payload.format && payload.format !== "sync") {
					throw new Error("Hub view document sync is read-only for peers.");
				}
				view.validateReadOnlySyncMessage(toUint8Array(payload.message));
			} catch (error) {
				this.log("warning", "crdt sync rejected", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});

		socket.on("session:crdt_resync_request", () => {
			const agentId = this.socketAgentIds.get(socket.id);
			if (!agentId) {
				return;
			}
			this.resetCrdtSyncForSocket(agentId, socket);
		});

		socket.on("disconnect", (reason) => {
			const initialTimer = this.initialCrdtSyncTimersBySocketId.get(socket.id);
			if (initialTimer) {
				clearTimeout(initialTimer);
				this.initialCrdtSyncTimersBySocketId.delete(socket.id);
			}
			this.crdtSyncStatesBySocketId.delete(socket.id);
			const bound = this.getBoundRuntime(socket);
			const effective = this.socketAgentIds.get(socket.id);
			if (bound && effective !== undefined) {
				const removedPeer = bound.peerRegistry.unregisterBySocketId(socket.id);
				this.socketAgentIds.delete(socket.id);
				this.socketIdentities.delete(socket.id);
				this.socketClientKinds.delete(socket.id);
				this.socketHostIds.delete(socket.id);
				if (removedPeer) {
					this.deps.onPeerConfigRemoved?.(effective, removedPeer.peerId);
					this.log("info", "peer disconnected", {
						agentId: effective,
						peerId: removedPeer.peerId,
						reason,
					});
					this.broadcastPeerListForAgent(effective);
				}
			} else {
				this.socketAgentIds.delete(socket.id);
				this.socketIdentities.delete(socket.id);
				this.socketClientKinds.delete(socket.id);
				this.socketHostIds.delete(socket.id);
			}
		});
	}

	private async handleSourceMessage(
		reg: { bound: HubAgentSocketBinding; peer: RegisteredPeer },
		payload: SourceMessagePayload,
		ack: (response: ActionAck) => void,
	): Promise<void> {
		if (typeof payload.sourceName !== "string" || payload.sourceName.trim().length === 0) {
			ack({ ok: false, error: "Source name is required." });
			return;
		}
		if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
			ack({ ok: false, error: "Source message text is required." });
			return;
		}
		if (
			payload.agentId !== undefined &&
			(typeof payload.agentId !== "string" || payload.agentId.trim().length === 0)
		) {
			ack({ ok: false, error: "Source message agentId must be a non-empty string when provided." });
			return;
		}
		const sourceName = payload.sourceName.trim();
		const text = payload.text.trim();
		const requestedAgentId = payload.agentId?.trim();
		const targetAgentIds = this.deps.getSourceMessageTargetAgentIds?.(
			reg.peer.agentId,
			sourceName,
			requestedAgentId,
		) ?? [requestedAgentId ?? reg.peer.agentId];
		const identity = this.socketIdentities.get(reg.peer.socketId);
		if (!identity) {
			ack({ ok: false, error: "Socket identity is missing." });
			return;
		}
		try {
			const targets: Array<{ agentId: string; adapter: HubAgentAdapter }> = [];
			for (const agentId of targetAgentIds) {
				if (!this.deps.isAgentInScope(identity.scopeRootAgentId, agentId)) {
					ack({ ok: false, error: `Token scope does not allow source message target: ${agentId}` });
					return;
				}
				const target = (await this.deps.ensureAgentStarted?.(agentId)) ?? this.deps.getAgentRuntime(agentId);
				const adapter = target?.agentAdapter;
				if (!adapter) {
					ack({ ok: false, error: `Hub agent runtime is not initialized for ${agentId}.` });
					return;
				}
				targets.push({ agentId, adapter });
			}
			for (const target of targets) {
				await target.adapter.enqueueFromSource(sourceName, text);
			}
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private broadcastPeerListForAgent(agentId: string): void {
		const runtime = this.deps.getAgentRuntime(agentId);
		if (!runtime || !this.io) {
			return;
		}
		if (!this.viewDocuments.has(agentId) && !this.hasConnectedCrdtPeerForAgent(agentId)) {
			return;
		}
		const peers = runtime.peerRegistry.list();
		this.getViewDocument(agentId).updatePeers(peers);
		this.scheduleCompactCheckForAgent(agentId);
		if (!this.hasConnectedCrdtPeerForAgent(agentId)) {
			return;
		}
		const emitStartedAt = Date.now();
		const stats = createSocketFanoutStats();
		let peerCount = 0;
		for (const s of this.io.sockets.sockets.values()) {
			if (this.socketAgentIds.get(s.id) === agentId) {
				peerCount += 1;
				mergeSocketFanoutStats(stats, this.emitPendingCrdtSyncToSocket(agentId, s));
			}
		}
		this.logSocketFanout("session:crdt_sync", agentId, peerCount, stats, 0, emitStartedAt);
	}

	private resolveToolCallPeerForSocket(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
	): { peer: RegisteredPeer } | undefined {
		const bound = this.getBoundRuntime(socket);
		if (!bound) {
			return undefined;
		}
		const peer = bound.peerRegistry.getBySocketId(socket.id);
		return peer ? { peer } : undefined;
	}

	private rememberViewImages(agentId: string, images: ImagePayload[]): void {
		if (images.length === 0) {
			return;
		}
		const existing = this.viewImagesByAgentId.get(agentId) ?? [];
		const byId = new Map(existing.map((image) => [image.imageId, image]));
		for (const image of images) {
			byId.set(image.imageId, image);
		}
		this.viewImagesByAgentId.set(agentId, [...byId.values()]);
	}

	private getViewDocument(agentId: string): HubViewDocument {
		let view = this.viewDocuments.get(agentId);
		if (!view) {
			view = new HubViewDocument();
			this.viewDocuments.set(agentId, view);
		}
		return view;
	}

	private getCrdtCompactThresholds(): SocketHubServerCrdtCompactThresholds {
		return this.deps.crdtCompactThresholds ?? DEFAULT_CRDT_COMPACT_THRESHOLDS;
	}

	private getConnectedCrdtSocketsForAgent(agentId: string): Socket<ClientToServerEvents, ServerToClientEvents>[] {
		if (!this.io) {
			return [];
		}
		return Array.from(this.io.sockets.sockets.values()).filter(
			(socket) => socket.connected && this.socketAgentIds.get(socket.id) === agentId,
		);
	}

	private hasConnectedCrdtPeerForAgent(agentId: string): boolean {
		if (!this.io) {
			return false;
		}
		for (const socket of this.io.sockets.sockets.values()) {
			if (socket.connected && this.socketAgentIds.get(socket.id) === agentId) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Throttled trigger for {@link maybeCompactCrdtHistoryForAgent}: a burst of mutations only
	 * incurs one check per {@link CRDT_COMPACT_THROTTLE_MS} window. We use a leading-edge timer
	 * (set on the first mutation, run later) so quiet periods do not keep retiring the timer.
	 */
	private scheduleCompactCheckForAgent(agentId: string): void {
		if (this.compactCheckTimersByAgentId.has(agentId)) {
			return;
		}
		const timer = setTimeout(() => {
			this.compactCheckTimersByAgentId.delete(agentId);
			this.maybeCompactCrdtHistoryForAgent(agentId);
		}, CRDT_COMPACT_THROTTLE_MS);
		// `unref` so a pending check does not keep the process alive during graceful shutdown.
		timer.unref?.();
		this.compactCheckTimersByAgentId.set(agentId, timer);
	}

	private clearCrdtSyncStatesForSockets(sockets: Socket<ClientToServerEvents, ServerToClientEvents>[]): void {
		for (const socket of sockets) {
			const initialTimer = this.initialCrdtSyncTimersBySocketId.get(socket.id);
			if (initialTimer) {
				clearTimeout(initialTimer);
				this.initialCrdtSyncTimersBySocketId.delete(socket.id);
			}
			this.crdtSyncStatesBySocketId.delete(socket.id);
		}
	}

	private maybeCompactCrdtHistoryForAgent(agentId: string): void {
		const view = this.viewDocuments.get(agentId);
		if (!view) {
			return;
		}
		const sockets = this.getConnectedCrdtSocketsForAgent(agentId);
		const thresholds = this.getCrdtCompactThresholds();
		const changeCount = view.getChangeCount();
		if (sockets.length === 0) {
			if (changeCount > thresholds.idleChangeCount) {
				view.compactHistory();
				const pending = this.pendingCrdtFanoutsByAgentId.get(agentId);
				if (pending) {
					if (pending.timer) {
						clearTimeout(pending.timer);
					}
					this.pendingCrdtFanoutsByAgentId.delete(agentId);
				}
			}
			return;
		}
		if (changeCount > thresholds.activeChangeCount) {
			view.compactHistory();
			this.clearCrdtSyncStatesForSockets(sockets);
			// Compaction discards per-socket sync state, so we must push a fresh snapshot fanout;
			// otherwise peers would only see a snapshot the next time something happens to mutate
			// the view document, which can be arbitrarily far in the future.
			this.scheduleCrdtFanoutForAgent(agentId, "session", SESSION_CRDT_FANOUT_DEBOUNCE_MS);
		}
	}

	private syncAgentListToAllViewDocuments(): void {
		const agentIds = this.deps.getAgentIds();
		for (const view of this.viewDocuments.values()) {
			view.syncAgentList(agentIds);
			for (const agentId of agentIds) {
				this.updateAgentMetadataInView(agentId, view);
			}
		}
	}

	private updateAgentMetadataInView(agentId: string, view: HubViewDocument): void {
		const metadata = this.deps.getAgentMetadata?.(agentId);
		if (!metadata) {
			return;
		}
		view.updateAgentMetadata(agentId, metadata);
	}

	private scheduleCrdtFanoutForAllAgents(): void {
		for (const agentId of this.viewDocuments.keys()) {
			this.scheduleCrdtFanoutForAgent(agentId, "session", SESSION_CRDT_FANOUT_DEBOUNCE_MS);
		}
	}

	private resetCrdtSyncForSocket(agentId: string, socket: Socket<ClientToServerEvents, ServerToClientEvents>): void {
		const initialTimer = this.initialCrdtSyncTimersBySocketId.get(socket.id);
		if (initialTimer) {
			clearTimeout(initialTimer);
			this.initialCrdtSyncTimersBySocketId.delete(socket.id);
		}
		if (!socket.connected || this.socketAgentIds.get(socket.id) !== agentId) {
			return;
		}
		this.crdtSyncStatesBySocketId.set(socket.id, this.getViewDocument(agentId).createSyncState());
		const emitStartedAt = Date.now();
		const stats = this.emitPendingCrdtSyncToSocket(agentId, socket);
		this.logSocketFanout("session:crdt_sync", agentId, 1, stats, 0, emitStartedAt);
	}

	private emitPendingCrdtSyncToSocket(
		agentId: string,
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
	): SocketFanoutStats {
		const stats = createSocketFanoutStats();
		const view = this.getViewDocument(agentId);
		let syncState = this.crdtSyncStatesBySocketId.get(socket.id);
		if (!syncState) {
			const existingTimer = this.initialCrdtSyncTimersBySocketId.get(socket.id);
			if (existingTimer) {
				clearTimeout(existingTimer);
			}
			const timer = setTimeout(() => {
				this.initialCrdtSyncTimersBySocketId.delete(socket.id);
				if (this.socketAgentIds.get(socket.id) === agentId && socket.connected) {
					this.crdtSyncStatesBySocketId.set(socket.id, view.createSyncState());
					const initialStats = this.emitPendingCrdtSyncToSocket(agentId, socket);
					this.logSocketFanout("session:crdt_sync", agentId, 1, initialStats, 0, Date.now());
				}
			}, INITIAL_CRDT_SYNC_DEBOUNCE_MS);
			this.initialCrdtSyncTimersBySocketId.set(socket.id, timer);
			return stats;
		}
		for (let i = 0; i < 8; i += 1) {
			const outgoing = view.generateSyncMessage(syncState);
			syncState = outgoing.syncState;
			this.crdtSyncStatesBySocketId.set(socket.id, syncState);
			if (!outgoing.message) {
				return stats;
			}
			recordSocketPayload(stats, outgoing.message.byteLength);
			socket
				.compress(shouldCompressCrdtPayload(outgoing.message.byteLength))
				.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
		}
		return stats;
	}

	private scheduleCrdtFanoutForAgent(agentId: string, reason: "session" | "live", delayMs: number): void {
		const existing = this.pendingCrdtFanoutsByAgentId.get(agentId);
		if (delayMs <= 0) {
			if (existing?.timer) {
				clearTimeout(existing.timer);
			}
			this.pendingCrdtFanoutsByAgentId.set(agentId, {
				eventCount: (existing?.eventCount ?? 0) + 1,
				reason,
				startedAt: existing?.startedAt ?? Date.now(),
			});
			this.flushCrdtFanoutForAgent(agentId);
			return;
		}
		if (existing) {
			existing.eventCount += 1;
			if (reason === "session" && existing.reason === "live") {
				if (existing.timer) {
					clearTimeout(existing.timer);
				}
				existing.timer = setTimeout(() => {
					this.flushCrdtFanoutForAgent(agentId);
				}, SESSION_CRDT_FANOUT_DEBOUNCE_MS);
				existing.timer.unref?.();
				existing.reason = "session";
			}
			return;
		}
		const startedAt = Date.now();
		const timer = setTimeout(() => {
			this.flushCrdtFanoutForAgent(agentId);
		}, delayMs);
		timer.unref?.();
		this.pendingCrdtFanoutsByAgentId.set(agentId, {
			timer,
			eventCount: 1,
			reason,
			startedAt,
		});
	}

	private flushCrdtFanoutForAgent(agentId: string): void {
		const pending = this.pendingCrdtFanoutsByAgentId.get(agentId);
		if (!pending) {
			return;
		}
		this.pendingCrdtFanoutsByAgentId.delete(agentId);
		if (!this.io) {
			return;
		}
		const stats = createSocketFanoutStats();
		let peerCount = 0;
		const emitStartedAt = Date.now();
		for (const socket of this.io.sockets.sockets.values()) {
			if (this.socketAgentIds.get(socket.id) === agentId) {
				peerCount += 1;
				mergeSocketFanoutStats(stats, this.emitPendingCrdtSyncToSocket(agentId, socket));
			}
		}
		this.logSocketFanout("session:crdt_sync", agentId, peerCount, stats, 0, emitStartedAt);
	}

	private emitSessionEventForAgent(agentId: string, event: HubSessionEvent): void {
		if (!this.io) {
			return;
		}
		const runtime = this.deps.getAgentRuntime(agentId);
		if (!runtime) {
			return;
		}
		if (!this.viewDocuments.has(agentId) && !this.hasConnectedCrdtPeerForAgent(agentId)) {
			return;
		}
		if (event.type === "snapshot_updated") {
			const materialized: MaterializedPeerPayload<{ snapshot: HubSessionSnapshot }> =
				this.imagePayloadCache.materializePeerPayload({ snapshot: runtime.sessionService.getSnapshot() });
			this.getViewDocument(agentId).updateSession(materialized.value.snapshot, agentId);
			this.rememberViewImages(agentId, materialized.images);
		} else {
			this.getViewDocument(agentId).updateSessionEvent(event, agentId);
		}
		this.scheduleCompactCheckForAgent(agentId);
		if (this.hasConnectedCrdtPeerForAgent(agentId)) {
			this.scheduleCrdtFanoutForAgent(agentId, "session", 0);
		}
	}

	private logSocketFanout(
		eventType: "session:crdt_sync",
		agentId: string,
		peerCount: number,
		stats: SocketFanoutStats,
		materializeMs: number,
		emitStartedAt: number,
	): void {
		const emitMs = Math.max(0, Date.now() - emitStartedAt);
		if (
			stats.payloadTotalBytes < SOCKET_SNAPSHOT_LOG_PAYLOAD_BYTES &&
			materializeMs < SOCKET_SNAPSHOT_LOG_DURATION_MS &&
			emitMs < SOCKET_SNAPSHOT_LOG_DURATION_MS
		) {
			return;
		}
		const payloadAverageBytes = stats.eventCount === 0 ? 0 : Math.round(stats.payloadTotalBytes / stats.eventCount);
		this.log("info", "socket fanout timing", {
			agentId,
			phase: "socket",
			eventType,
			peerCount,
			eventCount: stats.eventCount,
			payloadTotalBytes: stats.payloadTotalBytes,
			payloadMaxBytes: stats.payloadMaxBytes,
			payloadAverageBytes,
			materializeMs,
			emitMs,
		});
	}

	broadcastLiveEvent(agentId: string, event: LiveRenderEvent): void {
		if (!this.io) {
			return;
		}
		if (!this.viewDocuments.has(agentId) && !this.hasConnectedCrdtPeerForAgent(agentId)) {
			return;
		}
		const materialized: MaterializedPeerPayload<{ event: LiveRenderEvent }> =
			this.imagePayloadCache.materializePeerPayload({ event });
		this.getViewDocument(agentId).updateLiveEvent(materialized.value.event, agentId);
		this.rememberViewImages(agentId, materialized.images);
		this.scheduleCompactCheckForAgent(agentId);
		if (this.hasConnectedCrdtPeerForAgent(agentId)) {
			this.scheduleCrdtFanoutForAgent(agentId, "live", LIVE_CRDT_FANOUT_DEBOUNCE_MS);
		}
	}

	sendToolCallRequest(agentId: string, peerId: string, payload: ToolCallRequestPayload): void {
		const runtime = this.deps.getAgentRuntime(agentId);
		if (!runtime) {
			throw new Error(`Unknown agent id: ${agentId}`);
		}
		const peer = runtime.peerRegistry.get(peerId);
		if (!peer) {
			throw new Error(`Peer "${peerId}" is offline or not registered.`);
		}
		const socket = this.io?.sockets.sockets.get(peer.socketId);
		if (!socket) {
			throw new Error(`Peer "${peerId}" is not connected to the active hub transport.`);
		}
		socket.emit("tool:call_request", payload);
	}

	onToolCallAck(listener: (event: SocketHubServerToolCallEvent<ToolCallAckPayload>) => void): () => void {
		this.toolCallAckListeners.add(listener);
		return () => {
			this.toolCallAckListeners.delete(listener);
		};
	}

	onToolCallUpdate(listener: (event: SocketHubServerToolCallEvent<ToolCallUpdatePayload>) => void): () => void {
		this.toolCallUpdateListeners.add(listener);
		return () => {
			this.toolCallUpdateListeners.delete(listener);
		};
	}

	onToolCallResult(listener: (event: SocketHubServerToolCallEvent<ToolCallResultPayload>) => void): () => void {
		this.toolCallResultListeners.add(listener);
		return () => {
			this.toolCallResultListeners.delete(listener);
		};
	}

	onToolCallError(listener: (event: SocketHubServerToolCallEvent<ToolCallErrorPayload>) => void): () => void {
		this.toolCallErrorListeners.add(listener);
		return () => {
			this.toolCallErrorListeners.delete(listener);
		};
	}

	private emitToolCallAck(event: SocketHubServerToolCallEvent<ToolCallAckPayload>): void {
		for (const listener of this.toolCallAckListeners) {
			listener(event);
		}
	}

	private emitToolCallUpdate(event: SocketHubServerToolCallEvent<ToolCallUpdatePayload>): void {
		for (const listener of this.toolCallUpdateListeners) {
			listener(event);
		}
	}

	private emitToolCallResult(event: SocketHubServerToolCallEvent<ToolCallResultPayload>): void {
		for (const listener of this.toolCallResultListeners) {
			listener(event);
		}
	}

	private emitToolCallError(event: SocketHubServerToolCallEvent<ToolCallErrorPayload>): void {
		for (const listener of this.toolCallErrorListeners) {
			listener(event);
		}
	}

	private getRegisteredPeerForSocket(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
	): RegisteredPeer | undefined {
		const bound = this.getBoundRuntime(socket);
		if (!bound) {
			return undefined;
		}
		return bound.peerRegistry.getBySocketId(socket.id) ?? undefined;
	}

	private registeredPeerFromSocketForAction(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: ActionAck) => void,
	): { bound: HubAgentSocketBinding; peer: RegisteredPeer } | undefined {
		const bound = this.getBoundRuntime(socket);
		if (!bound) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
			return undefined;
		}
		const peer = bound.peerRegistry.getBySocketId(socket.id);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
		}
		if (!peer) {
			return undefined;
		}
		return { bound, peer };
	}

	private registeredClientFromSocketForAction(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: ActionAck) => void,
	):
		| { bound: HubAgentSocketBinding; clientKind: "host"; hostId: string }
		| { bound: HubAgentSocketBinding; clientKind: "peer"; peer: RegisteredPeer }
		| undefined {
		const bound = this.getBoundRuntime(socket);
		if (!bound) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
			return undefined;
		}
		const clientKind = this.socketClientKinds.get(socket.id) ?? "peer";
		if (clientKind === "host") {
			return { bound, clientKind, hostId: this.socketHostIds.get(socket.id) ?? HOST_CLIENT_PEER_ID };
		}
		const peer = bound.peerRegistry.getBySocketId(socket.id);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
			return undefined;
		}
		return { bound, clientKind, peer };
	}

	private registeredPeerFromSocketForSources(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: SessionGetSourcesAck) => void,
	): RegisteredPeer | undefined {
		const peer = this.getRegisteredPeerForSocket(socket);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
		}
		return peer;
	}

	private registeredPeerFromSocketForSourceMutate(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: SessionMutateSourceAck) => void,
	): RegisteredPeer | undefined {
		const peer = this.getRegisteredPeerForSocket(socket);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
		}
		return peer;
	}

	private registeredPeerFromSocketForMcpGet(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: SessionGetMcpServersAck) => void,
	): RegisteredPeer | undefined {
		const peer = this.getRegisteredPeerForSocket(socket);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
		}
		return peer;
	}

	private registeredPeerFromSocketForSkillGet(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: SessionGetSkillsAck) => void,
	): { bound: HubAgentSocketBinding; peer: RegisteredPeer } | undefined {
		const bound = this.getBoundRuntime(socket);
		if (!bound) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
			return undefined;
		}
		const peer = bound.peerRegistry.getBySocketId(socket.id);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
			return undefined;
		}
		return { bound, peer };
	}

	private registeredPeerFromSocketForMcpMutate(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		ack: (response: SessionMutateMcpServerAck) => void,
	): RegisteredPeer | undefined {
		const peer = this.getRegisteredPeerForSocket(socket);
		if (!peer) {
			ack({ ok: false, error: PEER_NOT_REGISTERED_MESSAGE });
		}
		return peer;
	}

	private async getAdapterForSocketAction(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		bound: HubAgentSocketBinding,
		ack: (response: ActionAck) => void,
	): Promise<HubAgentAdapter | undefined> {
		if (bound.agentAdapter) {
			return bound.agentAdapter;
		}
		const agentId = this.socketAgentIds.get(socket.id);
		const refreshed = agentId ? await this.deps.ensureAgentStarted?.(agentId) : undefined;
		const adapter = refreshed?.agentAdapter ?? bound.agentAdapter;
		if (!adapter) {
			ack({ ok: false, error: "Hub agent runtime is not initialized." });
			return undefined;
		}
		return adapter;
	}

	private async handleSimpleAction<TPayload>(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		bound: HubAgentSocketBinding,
		_payload: TPayload,
		ack: (response: ActionAck) => void,
		action: (adapter: HubAgentAdapter) => Promise<void>,
	): Promise<void> {
		const adapter = await this.getAdapterForSocketAction(socket, bound, ack);
		if (!adapter) {
			return;
		}

		try {
			await action(adapter);
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleSetModel(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		bound: HubAgentSocketBinding,
		payload: SessionSetModelPayload,
		ack: (response: ActionAck) => void,
	): Promise<void> {
		const adapter = await this.getAdapterForSocketAction(socket, bound, ack);
		if (!adapter) {
			return;
		}

		const models = adapter.services.modelRegistry.getAll();
		let modelIndex = -1;
		for (let i = models.length - 1; i >= 0; i -= 1) {
			const candidate = models[i];
			const resourceId =
				candidate && "resourceId" in candidate && typeof candidate.resourceId === "string"
					? candidate.resourceId
					: candidate
						? `${candidate.provider}:${candidate.id}`
						: undefined;
			if (resourceId === payload.modelResourceId) {
				modelIndex = i;
				break;
			}
		}
		const model = modelIndex >= 0 ? models[modelIndex] : undefined;
		if (!model) {
			ack({ ok: false, error: `Unknown model resourceId: ${payload.modelResourceId}` });
			return;
		}

		try {
			await adapter.setModel(model);
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleSetThinkingLevel(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		bound: HubAgentSocketBinding,
		payload: SessionSetThinkingLevelPayload,
		ack: (response: ActionAck) => void,
	): Promise<void> {
		const adapter = await this.getAdapterForSocketAction(socket, bound, ack);
		if (!adapter) {
			return;
		}
		if (!VALID_THINKING_LEVELS.has(payload.level)) {
			ack({ ok: false, error: `Invalid thinking level: ${payload.level}` });
			return;
		}

		try {
			adapter.setThinkingLevel(payload.level as Parameters<HubAgentAdapter["setThinkingLevel"]>[0]);
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleInvokeCommand(
		socket: Socket<ClientToServerEvents, ServerToClientEvents>,
		bound: HubAgentSocketBinding,
		payload: SessionInvokeCommandPayload,
		ack: (response: ActionAck) => void,
	): Promise<void> {
		const commandName = payload.commandName.trim();
		if (!commandName) {
			ack({ ok: false, error: "Command name is required." });
			return;
		}

		try {
			bound.sessionService.assertOperationSupported(commandName);
		} catch (error) {
			ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}

		switch (commandName) {
			case "compact":
				await this.handleSimpleAction(socket, bound, payload, ack, async (adapter) => {
					await adapter.compact(payload.args?.trim() || undefined);
				});
				return;
			case "dequeue":
				await this.handleSimpleAction(socket, bound, payload, ack, async (adapter) => {
					await adapter.dequeue();
				});
				return;
			case "reload":
				await this.handleSimpleAction(socket, bound, payload, ack, async (adapter) => {
					await adapter.reload();
				});
				return;
			default:
				ack({ ok: false, error: `Unsupported remote command: /${commandName}` });
		}
	}
}

function toUint8Array(value: Uint8Array): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	return new Uint8Array(value);
}

function createSocketFanoutStats(): SocketFanoutStats {
	return {
		eventCount: 0,
		payloadTotalBytes: 0,
		payloadMaxBytes: 0,
	};
}

function recordSocketPayload(stats: SocketFanoutStats, payloadBytes: number): void {
	stats.eventCount += 1;
	stats.payloadTotalBytes += payloadBytes;
	stats.payloadMaxBytes = Math.max(stats.payloadMaxBytes, payloadBytes);
}

function mergeSocketFanoutStats(target: SocketFanoutStats, source: SocketFanoutStats): void {
	target.eventCount += source.eventCount;
	target.payloadTotalBytes += source.payloadTotalBytes;
	target.payloadMaxBytes = Math.max(target.payloadMaxBytes, source.payloadMaxBytes);
}

/**
 * Single default-agent layout, matching pre-multi-agent `SocketHubServer` construction for tests
 * and focused harnesses.
 */
export function createMainOnlySocketHubServer(
	sessionService: HubSessionService,
	peerRegistry: PeerRegistry,
	getHubToolNames: () => string[],
	getAgentAdapter: () => HubAgentAdapter | undefined,
	getSourceStatuses: SocketHubServerDeps["getSourceStatuses"] = () => [],
	sourceMutators: SocketHubServerSourceMutators = DEFAULT_SOURCE_MUTATORS,
	getMcpServerStatuses: () => McpRuntimeStatus[] = () => [],
	getMcpConfigError: () => string | undefined = () => undefined,
	mcpMutators: SocketHubServerMcpMutators = DEFAULT_MCP_MUTATORS,
	webUiDistDir?: string,
	logs?: HubLogSink,
): SocketHubServer {
	const mainBinding: HubAgentSocketBinding = {
		sessionService,
		peerRegistry,
		get tools() {
			return getHubToolNames().map((name) => ({ name }) as ToolDefinition);
		},
		get agentAdapter() {
			return getAgentAdapter() ?? undefined;
		},
	} as HubAgentSocketBinding;

	return new SocketHubServer({
		getDefaultAgentId: () => ROOT_AGENT_ID,
		getAgentIds: () => [ROOT_AGENT_ID],
		getAgentRuntime: (id) => (id === ROOT_AGENT_ID ? mainBinding : undefined),
		getAgentMetadata: () => ({ kind: "root", lifecycle: "persistent" }),
		authenticateToken: (token) =>
			token
				? {
						id: "test-root",
						name: "root",
						description: "Test root identity",
						user: "test-root-user",
						purpose: "test root access",
						scopeRootAgentId: ROOT_AGENT_ID,
						createdByAgentId: ROOT_AGENT_ID,
						root: true,
					}
				: undefined,
		isAgentInScope: (scopeRootAgentId, targetAgentId) =>
			scopeRootAgentId === ROOT_AGENT_ID && targetAgentId === ROOT_AGENT_ID,
		getHttpSessionService: () => sessionService,
		subscribeAllAgentSessionEvents: (onEvent) => {
			return sessionService.subscribe((event) => onEvent(ROOT_AGENT_ID, event));
		},
		getSourceStatuses: () => getSourceStatuses(ROOT_AGENT_ID),
		sourceMutators,
		getMcpServerStatuses: () => getMcpServerStatuses(),
		getMcpConfigError: () => getMcpConfigError(),
		mcpMutators,
		...(logs === undefined ? {} : { logs }),
		...(webUiDistDir === undefined ? {} : { webUiDistDir }),
	});
}
