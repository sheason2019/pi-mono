import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AgentToolResult } from "@sheason/pi-coding-agent";
import { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import type { McpCapabilitySummary, McpRuntimeStatus } from "../../src/hub/mcp/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import { HubViewDocument } from "../../src/hub/session/hub-view-document.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import type { LiveRenderEvent } from "../../src/hub/transport/live-events.js";
import { HUB_PROTOCOL_VERSION, type SessionMutateMcpServerAck } from "../../src/hub/transport/protocol.js";
import {
	createMainOnlySocketHubServer,
	type SocketHubServer,
	type SocketHubServerMcpMutators,
} from "../../src/hub/transport/socket-hub-server.js";
import type { HubLogSink } from "../../src/hub/tui/hub-log.js";
import { SocketPeerClient } from "../../src/peer/client/socket-client.js";
import { PeerAppState } from "../../src/peer/state/peer-app-state.js";
import { PeerUiState } from "../../src/peer/state/peer-ui-state.js";

function createWelcome(peerId: string, protocolVersion = HUB_PROTOCOL_VERSION, agentId = "root") {
	return {
		sessionId: "stub-session",
		peerId,
		agentId,
		hubVersion: "0-test",
		protocolVersion,
		toolNames: [],
		identity: {
			id: "root",
			name: "root",
			description: "root",
			user: "test-user",
			purpose: "test access",
			scopeRootAgentId: "root",
			createdByAgentId: "root",
			root: true,
		},
		scopeRootAgentId: "root",
	};
}

function createMinimalSnapshot(): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id: "hub-test-session",
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
			version: 3,
		},
		sessionFile: "/tmp/session.json",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning: false,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

function createStubSessionService(): HubSessionService {
	const snapshot = createMinimalSnapshot();
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
	} as unknown as HubSessionService;
}

function createStubSessionServiceWithSnapshot(snapshot: HubSessionSnapshot): HubSessionService {
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
	} as unknown as HubSessionService;
}

function imageIdForPngData(data: string): string {
	return createHash("sha256").update("image/png").update("\0").update(data).digest("hex");
}

function pngImageToolResult(data: string): AgentToolResult<unknown> {
	return {
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: undefined,
	};
}

function createSnapshotWithImageToolData(imageData: string): HubSessionSnapshot {
	const toolResultMessage = {
		role: "toolResult" as const,
		toolCallId: "read:1",
		toolName: "read",
		content: pngImageToolResult(imageData).content,
		isError: false,
		timestamp: Date.now(),
	};
	return {
		...createMinimalSnapshot(),
		entries: [
			{
				type: "message",
				id: "entry-image-result",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: toolResultMessage,
			},
		],
		context: { messages: [toolResultMessage], thinkingLevel: "off", model: null },
	};
}

function firstPngImageBlockInSelectedAgent(appState: PeerAppState) {
	const agent = appState.getSnapshot().selectedAgent;
	if (!agent) {
		return undefined;
	}
	const hydrated = appState.getImageCache().hydrate(agent) as typeof agent;
	for (const item of hydrated.items) {
		if (item.type !== "message") {
			continue;
		}
		const message = item.message;
		const typedMessage = message as {
			content?: Array<{ type: string; data?: string; imageId?: string; mimeType?: string }>;
		};
		const block = Array.isArray(typedMessage.content)
			? typedMessage.content.find((c) => c.type === "image")
			: undefined;
		if (block) {
			return block;
		}
	}
	return undefined;
}

function firstAssistantText(appState: PeerAppState): string | undefined {
	const agent = appState.getSnapshot().selectedAgent;
	if (!agent) {
		return undefined;
	}
	for (const item of agent.items) {
		if (item.type !== "message") {
			continue;
		}
		const message = item.message;
		if (message.role !== "assistant") {
			continue;
		}
		const text = message.content.find((block) => block.type === "text");
		return text?.text;
	}
	return undefined;
}

const emptyCapabilities: McpCapabilitySummary = { tools: [], resources: [], prompts: [] };

function sampleMcpServers(): McpRuntimeStatus[] {
	return [
		{ name: "mcp-a", transport: "stdio", status: "running", capabilities: emptyCapabilities },
		{
			name: "mcp-b",
			transport: "http",
			status: "error",
			error: "connect failed",
			capabilities: emptyCapabilities,
		},
	];
}

function defaultMcpMutators(sample: McpRuntimeStatus[]): SocketHubServerMcpMutators {
	return {
		pauseServer: vi.fn(async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample })),
		restartServer: vi.fn(
			async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
		),
		removeServer: vi.fn(async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample })),
	};
}

function createMcpTestServer(
	getMcpServerStatuses: () => McpRuntimeStatus[],
	getMcpConfigError: () => string | undefined,
	mcpMutators: SocketHubServerMcpMutators,
	logs?: HubLogSink,
) {
	const mockAdapter = {} as unknown as HubAgentAdapter;
	const sessionService = createStubSessionService();
	const registry = new PeerRegistry();
	return createMainOnlySocketHubServer(
		sessionService,
		registry,
		() => [],
		() => mockAdapter,
		() => [],
		undefined,
		getMcpServerStatuses,
		getMcpConfigError,
		mcpMutators,
		undefined,
		logs,
	);
}

async function withConnectedSocketPeerClient(
	server: SocketHubServer,
	peerId: string,
	run: (client: SocketPeerClient) => Promise<void>,
) {
	const address = await server.start({ host: "127.0.0.1", port: 0 });
	const appState = new PeerAppState();
	const uiState = new PeerUiState();
	const socketPeer = new SocketPeerClient({
		hubUrl: `http://127.0.0.1:${address.port}`,
		hello: { peerId, token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
		appState,
		uiState,
	});
	try {
		await socketPeer.connect();
		await run(socketPeer);
	} finally {
		await socketPeer.disconnect();
		await server.stop();
	}
}

function createImageHubTestServer(sessionSnapshot: HubSessionSnapshot) {
	const mockAdapter = {} as unknown as HubAgentAdapter;
	const registry = new PeerRegistry();
	return createMainOnlySocketHubServer(
		createStubSessionServiceWithSnapshot(sessionSnapshot),
		registry,
		() => [],
		() => mockAdapter,
		() => [],
		undefined,
		() => [],
		() => undefined,
		defaultMcpMutators([]),
	);
}

function createSnapshotWithImageRefOnly(imageId: string, mimeType: string = "image/png"): HubSessionSnapshot {
	const refBlock = { type: "image" as const, imageId, data: "" as const, mimeType };
	const toolResultMessage = {
		role: "toolResult" as const,
		toolCallId: "read:1",
		toolName: "read",
		content: [{ type: "text" as const, text: "Read" }, refBlock],
		isError: false,
		timestamp: Date.now(),
	};
	return {
		...createMinimalSnapshot(),
		entries: [
			{
				type: "message",
				id: "entry-image-result",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: toolResultMessage,
			},
		],
		context: { messages: [toolResultMessage], thinkingLevel: "off", model: null },
	};
}

describe("SocketPeerClient queue write metadata", () => {
	it("sends terminal message sentAt metadata to the hub", async () => {
		const enqueueFromPeer = vi.fn(async (_peerId: string, _text: string, _metadata?: { sentAt?: string }) => {});
		const mockAdapter = { enqueueFromPeer } as unknown as HubAgentAdapter;
		const server = createMainOnlySocketHubServer(
			createStubSessionService(),
			new PeerRegistry(),
			() => [],
			() => mockAdapter,
		);

		await withConnectedSocketPeerClient(server, "peer-client-sent-at", async (client) => {
			await client.queueWrite("from-terminal");
		});

		expect(enqueueFromPeer).toHaveBeenCalledWith(
			"peer-client-sent-at",
			"from-terminal",
			expect.objectContaining({ sentAt: expect.any(String) }),
		);
		const metadata = enqueueFromPeer.mock.calls[0]?.[2];
		expect(Number.isFinite(Date.parse(metadata?.sentAt ?? ""))).toBe(true);
	});
});

describe("SocketPeerClient staged peer handshake", () => {
	it("prefers websocket transport while keeping polling as a fallback", () => {
		const source = readFileSync(join(__dirname, "../../src/peer/client/socket-client.ts"), "utf8");

		expect(source).toContain('transports: ["websocket", "polling"]');
		expect(source).toContain("tryAllTransports: true");
	});

	it("sends config after minimal hello and waits for session sync before completing startup", async () => {
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		const hubView = new HubViewDocument();
		hubView.updateSession(createMinimalSnapshot(), "root");
		let helloPayload: Record<string, unknown> | undefined;
		let configPayload: Record<string, unknown> | undefined;
		io.on("connection", (socket) => {
			let syncState = hubView.createSyncState();
			socket.on(
				"peer:hello",
				(hello: Record<string, unknown>, ack: (a: { ok: boolean; error?: string }) => void) => {
					helloPayload = hello;
					ack({ ok: true });
					socket.emit("hub:welcome", createWelcome(String(hello.peerId)));
				},
			);
			socket.on(
				"peer:config",
				(config: Record<string, unknown>, ack: (a: { ok: boolean; error?: string }) => void) => {
					configPayload = config;
					ack({ ok: true });
					for (let i = 0; i < 8; i += 1) {
						const outgoing = hubView.generateSyncMessage(syncState);
						syncState = outgoing.syncState;
						if (!outgoing.message) {
							return;
						}
						socket.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
					}
				},
			);
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: { peerId: "staged-peer", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
			appState,
			uiState,
		});
		try {
			await client.connect();
			expect(helloPayload).toEqual(expect.not.objectContaining({ configSnapshot: expect.anything() }));
			expect(configPayload).toBeUndefined();

			await client.uploadConfig({
				configSnapshot: {
					version: 1,
					capturedAt: "2026-05-08T00:00:00.000Z",
					cwd: "/tmp",
					global: {
						skills: [
							{ name: "big", description: "big", filePath: "/tmp/SKILL.md", content: "x".repeat(300_000) },
						],
					},
				},
				tools: ["read", "bash"],
			});
			await client.waitForInitialSync();

			expect(configPayload).toEqual(expect.objectContaining({ tools: ["read", "bash"] }));
			expect(appState.getSnapshot().welcome?.peerId).toBe("staged-peer");
			expect(appState.getSnapshot().selectedAgent?.sessionId).toBe("hub-test-session");
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});

	it("uploads peer config after hello without a config hash shortcut", async () => {
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		const hubView = new HubViewDocument();
		hubView.updateSession(createMinimalSnapshot(), "root");
		let helloPayload: Record<string, unknown> | undefined;
		let configUploadCount = 0;
		io.on("connection", (socket) => {
			let syncState = hubView.createSyncState();
			socket.on(
				"peer:hello",
				(hello: Record<string, unknown>, ack: (a: { ok: boolean; error?: string }) => void) => {
					helloPayload = hello;
					ack({ ok: true });
					socket.emit("hub:welcome", createWelcome(String(hello.peerId)));
					const outgoing = hubView.generateSyncMessage(syncState);
					syncState = outgoing.syncState;
					if (outgoing.message) {
						socket.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
					}
				},
			);
			socket.on(
				"peer:config",
				(_config: Record<string, unknown>, ack: (a: { ok: boolean; error?: string }) => void) => {
					configUploadCount += 1;
					ack({ ok: true });
				},
			);
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const logs: string[] = [];
		const appState = new PeerAppState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "config-peer",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState: new PeerUiState(),
			onHandshakeLog: (message) => logs.push(message),
		});
		try {
			await client.connect();
			await client.uploadConfig({ tools: ["expensive-tool"] });
			await client.waitForInitialSync();

			expect(helloPayload).toEqual(expect.not.objectContaining({ configHash: expect.anything() }));
			expect(configUploadCount).toBe(1);
			expect(logs).not.toEqual(expect.arrayContaining([expect.stringContaining("peer config unchanged")]));
			expect(appState.getSnapshot().selectedAgent?.sessionId).toBe("hub-test-session");
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});

	it("reports peer hello ack errors directly instead of timing out", async () => {
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		io.on("connection", (socket) => {
			socket.on("peer:hello", (_hello, ack: (a: { ok: boolean; error?: string }) => void) => {
				ack({ ok: false, error: "Protocol version mismatch: peer=3, hub=4" });
			});
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: { peerId: "bad-protocol", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
			appState: new PeerAppState(),
			uiState: new PeerUiState(),
		});
		try {
			await expect(client.connect()).rejects.toThrow("Protocol version mismatch: peer=3, hub=4");
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});

	it("reports a staged peer:hello ack timeout when the hub accepts the socket but does not ack hello", async () => {
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const logs: string[] = [];
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: { peerId: "slow-welcome", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
			appState: new PeerAppState(),
			uiState: new PeerUiState(),
			handshakeStageTimeoutMs: 50,
			onHandshakeLog: (message) => logs.push(message),
		});
		try {
			await expect(client.connect()).rejects.toThrow("Timed out waiting for peer:hello ack");
			expect(logs).toEqual(
				expect.arrayContaining([
					expect.stringContaining("waiting up to 50ms for peer:hello ack"),
					expect.stringContaining("peer:hello ack timed out after 50ms"),
				]),
			);
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});

	it("waits one event-loop turn before peer:hello so a real hub can install socket handlers", async () => {
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		io.on("connection", (socket) => {
			setImmediate(() => {
				socket.on(
					"peer:hello",
					(hello: Record<string, unknown>, ack: (a: { ok: boolean; error?: string }) => void) => {
						ack({ ok: true });
						socket.emit("hub:welcome", createWelcome(String(hello.peerId)));
					},
				);
			});
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "delayed-handler",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState: new PeerAppState(),
			uiState: new PeerUiState(),
			handshakeStageTimeoutMs: 500,
		});
		try {
			await expect(client.connect()).resolves.toBeUndefined();
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});

	it("logs each staged handshake step in real time", async () => {
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		const hubView = new HubViewDocument();
		hubView.updateSession(createMinimalSnapshot(), "root");
		io.on("connection", (socket) => {
			let syncState = hubView.createSyncState();
			socket.on(
				"peer:hello",
				(hello: Record<string, unknown>, ack: (a: { ok: boolean; error?: string }) => void) => {
					ack({ ok: true });
					socket.emit("hub:welcome", createWelcome(String(hello.peerId)));
				},
			);
			socket.on("peer:config", (_config, ack: (a: { ok: boolean; error?: string }) => void) => {
				ack({ ok: true });
				const outgoing = hubView.generateSyncMessage(syncState);
				syncState = outgoing.syncState;
				if (outgoing.message) {
					socket.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
				}
			});
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const logs: string[] = [];
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "logged-handshake",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState: new PeerAppState(),
			uiState: new PeerUiState(),
			onHandshakeLog: (message) => logs.push(message),
		});
		try {
			await client.connect();
			await client.uploadConfig({});
			await client.waitForInitialSync();

			expect(logs).toEqual(
				expect.arrayContaining([
					expect.stringContaining("connecting to hub"),
					expect.stringContaining("socket connected"),
					expect.stringContaining("peer:hello ack received"),
					expect.stringContaining("hub:welcome received"),
					expect.stringContaining("uploading peer config"),
					expect.stringContaining("peer:config ack received"),
					expect.stringContaining("initial session sync received"),
				]),
			);
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});
});

type ImageGetHandler = (
	imageId: string,
) => { ok: true; image: { imageId: string; mimeType: string; data: string } } | { ok: false; error: string };

async function startStubHubServer(options: {
	snapshot: HubSessionSnapshot;
	onImageGet?: ImageGetHandler;
	liveAfterSnapshot?: LiveRenderEvent;
	/** If set, emit a second `session:snapshot` on the next microtask (before acks if ack is delayed). */
	emitSecondSnapshotAfterFirst?: HubSessionSnapshot;
	/** Optional log of every `imageId` received by the server `image:get` handler (for dedupe tests). */
	imageGetCallLog?: string[];
	/** Optional log of every `imageId` received by the REST resource handler. */
	resourceGetCallLog?: string[];
	/** Delay before invoking the `image:get` ack (simulates in-flight fetch). */
	imageGetAckDelayMs?: number;
	/** If true, disconnect the server socket in a microtask after `image:get` (before a delayed ack). */
	forceDisconnectOnImageGet?: boolean;
	/** If `forceDisconnectOnImageGet` is set for the first `image:get` only, do not invoke the `ack` (in-flight was dropped with the socket). */
	dropImageGetAck?: boolean;
}): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const httpServer = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const prefix = "/resources/images/";
		if (request.method === "GET" && url.pathname.startsWith(prefix)) {
			const imageId = decodeURIComponent(url.pathname.slice(prefix.length)).trim();
			if (imageId) {
				options.resourceGetCallLog?.push(imageId);
			}
			const result = imageId ? options.onImageGet?.(imageId) : undefined;
			if (!result?.ok) {
				response.statusCode = 404;
				response.end();
				return;
			}
			const send = (): void => {
				response.statusCode = 200;
				response.setHeader("content-type", result.image.mimeType);
				response.end(Buffer.from(result.image.data, "base64"));
			};
			const delay = options.imageGetAckDelayMs ?? 0;
			if (delay > 0) {
				setTimeout(send, delay);
			} else {
				send();
			}
			return;
		}
		response.statusCode = 404;
		response.end();
	});
	const io = new Server(httpServer, { cors: { origin: "*" } });
	/** Monotonic so the second TCP connection's first `image:get` is not treated as a transport-drop scenario. */
	let imageGetIndexOnServer = 0;
	const hubView = new HubViewDocument();
	hubView.updateSession(options.snapshot, "root");
	io.on("connection", (s) => {
		const socket = s;
		let syncState = hubView.createSyncState();
		const emitPendingSync = (): void => {
			for (let i = 0; i < 8; i += 1) {
				const outgoing = hubView.generateSyncMessage(syncState);
				syncState = outgoing.syncState;
				if (!outgoing.message) {
					return;
				}
				socket.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
			}
		};
		socket.on(
			"peer:hello",
			(
				hello: { peerId: string; token: string; protocolVersion: number },
				ack: (a: { ok: boolean; error?: string }) => void,
			) => {
				ack({ ok: true });
				socket.emit("hub:welcome", createWelcome(hello.peerId, hello.protocolVersion));
				emitPendingSync();
				if (options.emitSecondSnapshotAfterFirst) {
					queueMicrotask(() => {
						hubView.updateSession(options.emitSecondSnapshotAfterFirst as HubSessionSnapshot, "root");
						emitPendingSync();
					});
				}
				if (options.liveAfterSnapshot) {
					queueMicrotask(() => {
						hubView.updateLiveEvent(options.liveAfterSnapshot as LiveRenderEvent, "root");
						emitPendingSync();
					});
				}
			},
		);
		socket.on("session:crdt_sync", (payload: { message: Uint8Array }) => {
			syncState = hubView.receiveSyncMessage(syncState, payload.message);
			emitPendingSync();
		});
		socket.on(
			"image:get",
			(
				payload: { imageId?: string },
				ack: (
					a:
						| { ok: true; image: { imageId: string; mimeType: string; data: string } }
						| { ok: false; error: string },
				) => void,
			) => {
				const id = typeof payload?.imageId === "string" ? payload.imageId : "";
				options.imageGetCallLog?.push(id);
				const n = imageGetIndexOnServer++;
				if (options.forceDisconnectOnImageGet && n === 0) {
					queueMicrotask(() => {
						socket.disconnect(true);
					});
					if (options.dropImageGetAck) {
						return;
					}
				}
				const finish = (): void => {
					ack({ ok: false, error: "socket image:get is disabled; use REST resources" });
				};
				const delay = options.imageGetAckDelayMs ?? 0;
				if (delay > 0) {
					setTimeout(finish, delay);
				} else {
					finish();
				}
			},
		);
	});
	await new Promise<void>((resolve) => {
		httpServer.listen(0, "127.0.0.1", () => resolve());
	});
	const address = httpServer.address() as AddressInfo;
	return {
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		},
	};
}

describe("SocketPeerClient welcome metadata", () => {
	it("stores hub:welcome agentId in app state (default root) when using the in-repo hub server", async () => {
		const server = createMcpTestServer(
			() => sampleMcpServers(),
			() => undefined,
			defaultMcpMutators(sampleMcpServers()),
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: { peerId: "peer-w2", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
			appState,
			uiState,
		});
		try {
			await client.connect();
			expect(appState.getSnapshot().welcome?.agentId).toBe("root");
		} finally {
			await client.disconnect();
			await server.stop();
		}
	});

	it("projects Socket.IO reconnect state after connection loss and supports immediate retry", async () => {
		const stub = await startStubHubServer({ snapshot: createMinimalSnapshot() });
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-reconnect-state",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
			reconnectDelayMs: 3000,
		});
		try {
			await client.connect();
			await stub.close();
			await vi.waitFor(() => {
				const snapshot = uiState.getSnapshot();
				expect(snapshot.connectionState).toBe("reconnecting");
				expect(snapshot.connectionMessage).toContain("Socket.IO reconnecting");
			});

			client.retryConnectionNow();

			expect(uiState.getSnapshot()).toEqual(
				expect.objectContaining({
					connectionState: "reconnecting",
					connectionMessage: "Retrying connection to hub now...",
				}),
			);
		} finally {
			await client.disconnect();
		}
	});
});

describe("SocketPeerClient CRDT session sync", () => {
	it("applies hub-owned CRDT session state without a session snapshot fallback", async () => {
		const initial = createMinimalSnapshot();
		const updated: HubSessionSnapshot = {
			...initial,
			isRunning: true,
			runStartedAt: "2026-04-27T08:00:00.000Z",
		};
		const hubView = new HubViewDocument();
		hubView.updateSession(initial, "root");
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });

		io.on("connection", (socket) => {
			let syncState = hubView.createSyncState();
			const emitPendingSync = (): void => {
				for (let i = 0; i < 8; i += 1) {
					const outgoing = hubView.generateSyncMessage(syncState);
					syncState = outgoing.syncState;
					if (!outgoing.message) {
						return;
					}
					socket.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
				}
			};
			socket.on(
				"peer:hello",
				(
					hello: { peerId: string; token: string; protocolVersion: number },
					ack: (a: { ok: boolean; error?: string }) => void,
				) => {
					ack({ ok: true });
					socket.emit("hub:welcome", createWelcome(hello.peerId, hello.protocolVersion));
					emitPendingSync();
					queueMicrotask(() => {
						hubView.updateSession(updated, "root");
						emitPendingSync();
					});
				},
			);
			socket.on("session:crdt_sync", (payload: { message: Uint8Array }) => {
				syncState = hubView.receiveSyncMessage(syncState, payload.message);
				emitPendingSync();
			});
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: { peerId: "peer-crdt", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
			appState,
			uiState,
		});

		try {
			await client.connect();
			await vi.waitFor(() => {
				expect(appState.getSnapshot().selectedAgent?.status.isRunning).toBe(true);
				expect(appState.getSnapshot().selectedAgent?.status.runStartedAt).toBe("2026-04-27T08:00:00.000Z");
			});
		} finally {
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});

	it("paces queued live CRDT sync messages without outrunning the TUI render timer", async () => {
		const hubView = new HubViewDocument();
		hubView.resetSession({ ...createMinimalSnapshot(), isRunning: true }, "root");
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		appState.applyWelcome(createWelcome("peer-crdt-stream"));
		const client = new SocketPeerClient({
			hubUrl: "http://127.0.0.1:1",
			hello: {
				peerId: "peer-crdt-stream",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		let syncState = hubView.createSyncState();
		for (let i = 0; i < 8; i += 1) {
			const outgoing = hubView.generateSyncMessage(syncState);
			syncState = outgoing.syncState;
			if (!outgoing.message) {
				break;
			}
			appState.applyCrdtSyncMessage(outgoing.message, outgoing.format);
		}
		const observedTexts: string[] = [];
		const unsubscribe = appState.subscribe(() => {
			const text = firstAssistantText(appState);
			if (text !== undefined) {
				observedTexts.push(text);
			}
		});
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "first" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1234,
		};
		hubView.updateLiveEvent({ type: "assistant_message_start", messageId: "assistant-live", message }, "root");
		const firstSync = hubView.generateSyncMessage(syncState);
		syncState = firstSync.syncState;
		message.content[0]!.text = "first second";
		hubView.updateLiveEvent({ type: "assistant_message_update", messageId: "assistant-live", message }, "root");
		const secondSync = hubView.generateSyncMessage(syncState);
		type FakeCrdtSocket = {
			connected: boolean;
			emit: ReturnType<typeof vi.fn>;
		};
		const socket: FakeCrdtSocket = {
			connected: true,
			emit: vi.fn(),
		};
		const clientInternals = client as unknown as {
			socket: FakeCrdtSocket;
			enqueueCrdtSyncMessage: (
				socket: FakeCrdtSocket,
				message: Uint8Array,
				format: typeof firstSync.format,
				hooks: undefined,
			) => void;
			clearPendingCrdtSyncMessages: () => void;
		};
		clientInternals.socket = socket;

		try {
			expect(firstSync.message).toBeDefined();
			expect(secondSync.message).toBeDefined();
			clientInternals.enqueueCrdtSyncMessage(socket, firstSync.message!, firstSync.format, undefined);
			clientInternals.enqueueCrdtSyncMessage(socket, secondSync.message!, secondSync.format, undefined);

			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setImmediate(resolve));
			expect(observedTexts).toEqual(["first"]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setImmediate(resolve));
			expect(observedTexts).toEqual(["first", "first second"]);
		} finally {
			unsubscribe();
			clientInternals.clearPendingCrdtSyncMessages();
		}
	});

	it("requests CRDT resync and keeps the current view when applying a sync message fails", async () => {
		const initial: HubSessionSnapshot = {
			...createMinimalSnapshot(),
			isRunning: true,
			runStartedAt: "2026-04-27T08:00:00.000Z",
		};
		const hubView = new HubViewDocument();
		hubView.updateSession(initial, "root");
		const httpServer = createServer();
		const io = new Server(httpServer, { cors: { origin: "*" } });
		let resyncRequests = 0;

		io.on("connection", (socket) => {
			let syncState = hubView.createSyncState();
			const emitPendingSync = (): void => {
				for (let i = 0; i < 8; i += 1) {
					const outgoing = hubView.generateSyncMessage(syncState);
					syncState = outgoing.syncState;
					if (!outgoing.message) {
						return;
					}
					socket.emit("session:crdt_sync", { message: outgoing.message, format: outgoing.format });
				}
			};
			socket.on(
				"peer:hello",
				(
					hello: { peerId: string; token: string; protocolVersion: number },
					ack: (a: { ok: boolean; error?: string }) => void,
				) => {
					ack({ ok: true });
					socket.emit("hub:welcome", createWelcome(hello.peerId, hello.protocolVersion));
					emitPendingSync();
					queueMicrotask(() => {
						socket.emit("session:crdt_sync", { message: new Uint8Array([1, 2, 3, 4]) });
					});
				},
			);
			socket.on("session:crdt_resync_request", () => {
				resyncRequests += 1;
			});
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address() as AddressInfo;
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const resyncStates: boolean[] = [];
		const unsubscribeUi = uiState.subscribe((snapshot) => {
			resyncStates.push(snapshot.isCrdtResyncing === true);
		});
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "peer-crdt-resync",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});

		try {
			await client.connect();
			await vi.waitFor(() => {
				expect(resyncRequests).toBe(1);
			});
			expect(appState.getSnapshot().selectedAgent?.status.isRunning).toBe(true);
			expect(resyncStates).toContain(true);
		} finally {
			unsubscribeUi();
			await client.disconnect();
			await new Promise<void>((resolve) => {
				io.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		}
	});
});

describe("SocketPeerClient MCP server actions", () => {
	it("hub logs peer-local MCP config and server errors from peer config upload", async () => {
		const logs = {
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
		};
		const server = createMcpTestServer(
			() => [],
			() => undefined,
			defaultMcpMutators([]),
			logs,
		);
		await withConnectedSocketPeerClient(server, "peer-mcp-log", async (client) => {
			await client.uploadConfig({
				mcpSnapshot: {
					configError: "mcp.json invalid",
					servers: [
						{
							resourceId: "zai-id",
							name: "zai-mcp-server",
							transport: "stdio",
							status: "error",
							error: "MCP client connection or capability discovery timed out after 10000ms",
							capabilities: emptyCapabilities,
						},
					],
				},
			});
		});

		expect(logs.warning).toHaveBeenCalledWith(
			"peer mcp config error",
			expect.objectContaining({ agentId: "root", peerId: "peer-mcp-log", error: "mcp.json invalid" }),
		);
		expect(logs.error).toHaveBeenCalledWith(
			"peer mcp server error",
			expect.objectContaining({
				agentId: "root",
				peerId: "peer-mcp-log",
				mcpServer: "zai-mcp-server",
				error: "MCP client connection or capability discovery timed out after 10000ms",
			}),
		);
	});

	it("getMcpServers returns servers and omits configError when the hub has none", async () => {
		const sample = sampleMcpServers();
		const getMcpServerStatuses = vi.fn((): McpRuntimeStatus[] => sample);
		const getMcpConfigError = vi.fn((): string | undefined => undefined);
		const mcpMutators = defaultMcpMutators(sample);
		const server = createMcpTestServer(getMcpServerStatuses, getMcpConfigError, mcpMutators);
		await withConnectedSocketPeerClient(server, "peer-mcp-get-1", async (client) => {
			const result = await client.getMcpServers();
			expect(result.servers).toEqual(sample);
			expect("configError" in result).toBe(false);
			expect(getMcpServerStatuses).toHaveBeenCalledTimes(1);
			expect(getMcpConfigError).toHaveBeenCalled();
		});
	});

	it("getMcpServers includes configError when the hub returns one", async () => {
		const sample = sampleMcpServers();
		const getMcpServerStatuses = vi.fn((): McpRuntimeStatus[] => sample);
		const getMcpConfigError = vi.fn((): string | undefined => "mcp.json invalid");
		const mcpMutators = defaultMcpMutators(sample);
		const server = createMcpTestServer(getMcpServerStatuses, getMcpConfigError, mcpMutators);
		await withConnectedSocketPeerClient(server, "peer-mcp-get-2", async (client) => {
			const result = await client.getMcpServers();
			expect(result.servers).toEqual(sample);
			expect(result).toEqual({ servers: sample, configError: "mcp.json invalid" });
		});
	});

	it("getMcpServers rejects when the ack is not ok", async () => {
		const getMcpServerStatuses = vi.fn((): McpRuntimeStatus[] => {
			throw new Error("mcp list boom");
		});
		const getMcpConfigError = vi.fn((): string | undefined => undefined);
		const mcpMutators = defaultMcpMutators(sampleMcpServers());
		const server = createMcpTestServer(getMcpServerStatuses, getMcpConfigError, mcpMutators);
		await withConnectedSocketPeerClient(server, "peer-mcp-get-3", async (client) => {
			await expect(client.getMcpServers()).rejects.toThrow("mcp list boom");
		});
	});

	it("pauseMcpServer sends session:pause_mcp_server with the name and resolves servers from ack", async () => {
		const sample = sampleMcpServers();
		const afterPause: McpRuntimeStatus[] = [
			{ name: "mcp-a", transport: "stdio", status: "stopped", capabilities: emptyCapabilities },
		];
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(async (agentId, name): Promise<SessionMutateMcpServerAck> => {
				expect(agentId).toBe("root");
				expect(name).toBe("mcp-a");
				return { ok: true, servers: afterPause };
			}),
			restartServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			removeServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
		};
		const server = createMcpTestServer(
			() => sample,
			() => undefined,
			mcpMutators,
		);
		await withConnectedSocketPeerClient(server, "peer-mcp-pause-1", async (client) => {
			const out = await client.pauseMcpServer("mcp-a");
			expect(out).toEqual(afterPause);
			expect(mcpMutators.pauseServer).toHaveBeenCalledWith("root", "mcp-a");
		});
	});

	it("pauseMcpServer rejects when the mutator returns ok: false", async () => {
		const sample = sampleMcpServers();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({
					ok: false,
					error: "no such server",
				}),
			),
			restartServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			removeServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
		};
		const server = createMcpTestServer(
			() => sample,
			() => undefined,
			mcpMutators,
		);
		await withConnectedSocketPeerClient(server, "peer-mcp-pause-2", async (client) => {
			await expect(client.pauseMcpServer("ghost")).rejects.toThrow("no such server");
		});
	});

	it("restartMcpServer sends the event and returns servers from ack", async () => {
		const sample = sampleMcpServers();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			restartServer: vi.fn(async (agentId, name): Promise<SessionMutateMcpServerAck> => {
				expect(agentId).toBe("root");
				expect(name).toBe("mcp-b");
				return { ok: true, servers: sample };
			}),
			removeServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
		};
		const server = createMcpTestServer(
			() => sample,
			() => undefined,
			mcpMutators,
		);
		await withConnectedSocketPeerClient(server, "peer-mcp-restart-1", async (client) => {
			const out = await client.restartMcpServer("mcp-b");
			expect(out).toEqual(sample);
			expect(mcpMutators.restartServer).toHaveBeenCalledWith("root", "mcp-b");
		});
	});

	it("removeMcpServer sends the event and returns servers from ack", async () => {
		const sample = sampleMcpServers();
		const afterRemove: McpRuntimeStatus[] = [sample[1] as McpRuntimeStatus];
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			restartServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			removeServer: vi.fn(async (agentId, name): Promise<SessionMutateMcpServerAck> => {
				expect(agentId).toBe("root");
				expect(name).toBe("mcp-a");
				return { ok: true, servers: afterRemove };
			}),
		};
		const server = createMcpTestServer(
			() => sample,
			() => undefined,
			mcpMutators,
		);
		await withConnectedSocketPeerClient(server, "peer-mcp-remove-1", async (client) => {
			const out = await client.removeMcpServer("mcp-a");
			expect(out).toEqual(afterRemove);
			expect(mcpMutators.removeServer).toHaveBeenCalledWith("root", "mcp-a");
		});
	});
});

describe("SocketPeerClient image cache", () => {
	it("hydrates image refs from the hub REST image resource, not socket image payloads", async () => {
		const imageData = Buffer.from("real hub image bytes").toString("base64");
		const expectedId = imageIdForPngData(imageData);
		const server = createImageHubTestServer(createSnapshotWithImageToolData(imageData));
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "peer-img-hydrate",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await client.uploadConfig({});
			await client.waitForInitialSync();
			await vi.waitFor(() => {
				const block = firstPngImageBlockInSelectedAgent(appState);
				expect(block).toBeDefined();
				expect(block?.data).toBe(imageData);
				expect(block?.imageId).toBe(expectedId);
			});
		} finally {
			await client.disconnect();
			await server.stop();
		}
	});

	it("snapshot with missing image ref fetches the REST image resource and hydrates session", async () => {
		const dataRaw = "a";
		const id = imageIdForPngData(dataRaw);
		const imageDataB64 = Buffer.from(dataRaw, "utf8").toString("base64");
		const socketGetLog: string[] = [];
		const resourceLog: string[] = [];
		const snapshot = createSnapshotWithImageRefOnly(id);
		const stub = await startStubHubServer({
			snapshot,
			onImageGet: (reqId) => {
				if (reqId === id) {
					return { ok: true, image: { imageId: id, mimeType: "image/png", data: imageDataB64 } };
				}
				return { ok: false, error: "not found" };
			},
			imageGetCallLog: socketGetLog,
			resourceGetCallLog: resourceLog,
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: { peerId: "peer-img-get", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION, version: "test" },
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const block = firstPngImageBlockInSelectedAgent(appState);
				expect(block?.data).toBe(imageDataB64);
			});
			expect(socketGetLog).toEqual([]);
			expect(resourceLog).toEqual([id]);
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("failed REST image fetch does not prevent snapshot from applying; image ref stays unhydrated", async () => {
		const dataRaw = "b";
		const id = imageIdForPngData(dataRaw);
		const snapshot = createSnapshotWithImageRefOnly(id);
		const stub = await startStubHubServer({
			snapshot,
			onImageGet: () => ({ ok: false, error: "not in cache" }),
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-img-fail",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const block = firstPngImageBlockInSelectedAgent(appState);
				expect(block).toBeDefined();
				expect(block?.data).toBe("");
				expect(appState.getSnapshot().selectedAgent).toBeDefined();
			});
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("session:live with missing image ref fetches REST image resource; tool result hydrates after fetch", async () => {
		const dataRaw = "c";
		const id = imageIdForPngData(dataRaw);
		const imageB64 = Buffer.from(dataRaw, "utf8").toString("base64");
		const refResult = {
			content: [
				{ type: "text" as const, text: "live" },
				{ type: "image" as const, imageId: id, data: "" as const, mimeType: "image/png" },
			],
			details: undefined,
		} as AgentToolResult<unknown>;
		const liveEvent: LiveRenderEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-live-1",
			toolName: "read",
			result: refResult,
			isError: false,
		};
		const stub = await startStubHubServer({
			snapshot: createMinimalSnapshot(),
			liveAfterSnapshot: liveEvent,
			onImageGet: (reqId) => {
				if (reqId === id) {
					return { ok: true, image: { imageId: id, mimeType: "image/png", data: imageB64 } };
				}
				return { ok: false, error: "missing" };
			},
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-img-live",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const execs = appState.getSnapshot().live.toolExecutions;
				const end = execs.find((e) => e.toolCallId === "tc-live-1");
				const content = end?.result?.content as
					| Array<{ type: string; data?: string; imageId?: string }>
					| undefined;
				const img = content?.find((c) => c.type === "image");
				expect(img?.data).toBe(imageB64);
			});
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("session:live ref-only image hydrates from REST resource (shape used by live ToolExecutionComponent rows)", async () => {
		const dataRaw = "e";
		const id = imageIdForPngData(dataRaw);
		const imageB64 = Buffer.from(dataRaw, "utf8").toString("base64");
		const refResult = {
			content: [
				{ type: "text" as const, text: "live-payload" },
				{ type: "image" as const, imageId: id, data: "" as const, mimeType: "image/png" },
			],
			details: undefined,
		} as AgentToolResult<unknown>;
		const liveEvent: LiveRenderEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-live-payload-1",
			toolName: "read",
			result: refResult,
			isError: false,
		};
		const stub = await startStubHubServer({
			snapshot: createMinimalSnapshot(),
			liveAfterSnapshot: liveEvent,
			onImageGet: (reqId) => {
				if (reqId === id) {
					return { ok: true, image: { imageId: id, mimeType: "image/png", data: imageB64 } };
				}
				return { ok: false, error: "missing" };
			},
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-img-live-payload",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const execs = appState.getSnapshot().live.toolExecutions;
				const end = execs.find((e) => e.toolCallId === "tc-live-payload-1");
				const content = end?.result?.content as
					| Array<{ type: string; data?: string; mimeType?: string }>
					| undefined;
				const img = content?.find((c) => c.type === "image");
				expect(img?.data).toBe(imageB64);
				expect(img?.mimeType).toBe("image/png");
			});
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("session:live with missing image ref and failed REST fetch still applies live tool result", async () => {
		const dataRaw = "d";
		const id = imageIdForPngData(dataRaw);
		const callLog: string[] = [];
		const refResult = {
			content: [
				{ type: "text" as const, text: "live-fail" },
				{ type: "image" as const, imageId: id, data: "" as const, mimeType: "image/png" },
			],
			details: undefined,
		} as AgentToolResult<unknown>;
		const liveEvent: LiveRenderEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-live-fail-1",
			toolName: "read",
			result: refResult,
			isError: false,
		};
		const stub = await startStubHubServer({
			snapshot: createMinimalSnapshot(),
			liveAfterSnapshot: liveEvent,
			onImageGet: () => ({ ok: false, error: "not in cache" }),
			imageGetCallLog: callLog,
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-img-live-fail",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const execs = appState.getSnapshot().live.toolExecutions;
				const end = execs.find((e) => e.toolCallId === "tc-live-fail-1");
				expect(end).toBeDefined();
			});
			expect(callLog).toEqual([]);
			const execs = appState.getSnapshot().live.toolExecutions;
			const end = execs.find((e) => e.toolCallId === "tc-live-fail-1");
			const content = end?.result?.content as Array<{ type: string; data?: string; imageId?: string }> | undefined;
			const img = content?.find((c) => c.type === "image");
			expect(img?.data).toBe("");
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("explicit reconnect retries a previously failed REST image fetch", async () => {
		const dataRaw = "g";
		const id = imageIdForPngData(dataRaw);
		const imageB64 = Buffer.from(dataRaw, "utf8").toString("base64");
		const resourceLog: string[] = [];
		let failFirst = true;
		const refSnap = createSnapshotWithImageRefOnly(id);
		const stub = await startStubHubServer({
			snapshot: refSnap,
			onImageGet: (reqId) => {
				if (failFirst) {
					failFirst = false;
					return { ok: false, error: "temporary miss" };
				}
				if (reqId === id) {
					return { ok: true, image: { imageId: id, mimeType: "image/png", data: imageB64 } };
				}
				return { ok: false, error: "no" };
			},
			resourceGetCallLog: resourceLog,
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-reconnect-img",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			expect(appState.getImageCache().get(id)).toBeUndefined();
			await vi.waitFor(() => {
				expect(resourceLog.filter((x) => x === id).length).toBe(1);
			});
			await client.disconnect();
			await client.connect();
			await vi.waitFor(
				() => {
					expect(resourceLog.filter((x) => x === id).length).toBe(2);
					const block = firstPngImageBlockInSelectedAgent(appState);
					expect(block?.data).toBe(imageB64);
				},
				{ timeout: 15_000 },
			);
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("repeated session:snapshot for the same missing imageId while the first REST fetch is in flight issues one resource request", async () => {
		const dataRaw = "e";
		const id = imageIdForPngData(dataRaw);
		const snap = createSnapshotWithImageRefOnly(id);
		const imageDataB64 = Buffer.from("e", "utf8").toString("base64");
		const socketGetLog: string[] = [];
		const resourceLog: string[] = [];
		const stub = await startStubHubServer({
			snapshot: snap,
			emitSecondSnapshotAfterFirst: snap,
			onImageGet: (reqId) => {
				if (reqId === id) {
					return { ok: true, image: { imageId: id, mimeType: "image/png", data: imageDataB64 } };
				}
				return { ok: false, error: "not found" };
			},
			imageGetCallLog: socketGetLog,
			resourceGetCallLog: resourceLog,
			imageGetAckDelayMs: 100,
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-img-dedupe",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const block = firstPngImageBlockInSelectedAgent(appState);
				expect(block?.data).toBe(imageDataB64);
			});
			expect(socketGetLog).toEqual([]);
			const sameId = resourceLog.filter((x) => x === id);
			expect(sameId.length).toBe(1);
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});

	it("session:snapshot then session:live with the same missing imageId while REST fetch is in flight issues one resource request", async () => {
		const dataRaw = "f";
		const id = imageIdForPngData(dataRaw);
		const imageDataB64 = Buffer.from(dataRaw, "utf8").toString("base64");
		const snap = createSnapshotWithImageRefOnly(id);
		const refResult = {
			content: [
				{ type: "text" as const, text: "dedupe-live" },
				{ type: "image" as const, imageId: id, data: "" as const, mimeType: "image/png" },
			],
			details: undefined,
		} as AgentToolResult<unknown>;
		const liveEvent: LiveRenderEvent = {
			type: "tool_execution_end",
			toolCallId: "tc-dedupe-live",
			toolName: "read",
			result: refResult,
			isError: false,
		};
		const socketGetLog: string[] = [];
		const resourceLog: string[] = [];
		const stub = await startStubHubServer({
			snapshot: snap,
			liveAfterSnapshot: liveEvent,
			onImageGet: (reqId) => {
				if (reqId === id) {
					return { ok: true, image: { imageId: id, mimeType: "image/png", data: imageDataB64 } };
				}
				return { ok: false, error: "not found" };
			},
			imageGetCallLog: socketGetLog,
			resourceGetCallLog: resourceLog,
			imageGetAckDelayMs: 100,
		});
		const appState = new PeerAppState();
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${stub.port}`,
			hello: {
				peerId: "peer-img-dedupe-sl",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});
		try {
			await client.connect();
			await vi.waitFor(() => {
				const content = appState.getSnapshot().live.toolExecutions.find((e) => e.toolCallId === "tc-dedupe-live")
					?.result?.content as Array<{ type: string; data?: string }> | undefined;
				const img = content?.find((c) => c.type === "image");
				expect(img?.data).toBe(imageDataB64);
			});
			expect(socketGetLog).toEqual([]);
			expect(resourceLog.filter((x) => x === id).length).toBe(1);
		} finally {
			await client.disconnect();
			await stub.close();
		}
	});
});
