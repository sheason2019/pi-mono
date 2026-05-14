import { createHash } from "node:crypto";
import * as Automerge from "@automerge/automerge";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubViewDocument, HubViewDocumentState } from "../../src/hub/session/hub-view-document.js";
import type { HubSessionEvent } from "../../src/hub/session/session-events.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import { HUB_PROTOCOL_VERSION, type SessionCrdtSyncPayload } from "../../src/hub/transport/protocol.js";
import {
	createMainOnlySocketHubServer,
	type HubAgentSocketBinding,
	SocketHubServer,
	type SocketHubServerCrdtCompactThresholds,
} from "../../src/hub/transport/socket-hub-server.js";

function createMinimalSnapshot(overrides: Partial<HubSessionSnapshot> = {}): HubSessionSnapshot {
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
		...overrides,
	};
}

function createStubSessionService(snapshot: HubSessionSnapshot = createMinimalSnapshot()): HubSessionService {
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
	} as unknown as HubSessionService;
}

function createCountedSessionService(snapshot: HubSessionSnapshot = createMinimalSnapshot()): HubSessionService & {
	getSnapshotCount: () => number;
} {
	let getSnapshotCount = 0;
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => {
			getSnapshotCount += 1;
			return snapshot;
		},
		getSnapshotCount: () => getSnapshotCount,
		recordError: () => {},
	} as unknown as HubSessionService & { getSnapshotCount: () => number };
}

type HubSessionServiceWithNotify = HubSessionService & {
	notify: (event: HubSessionEvent) => void;
	setSnapshot: (snapshot: HubSessionSnapshot) => void;
	getSnapshotCount: () => number;
};

function createNotifyableSessionService(
	snapshot: HubSessionSnapshot = createMinimalSnapshot(),
): HubSessionServiceWithNotify {
	const subscribers: ((event: HubSessionEvent) => void)[] = [];
	let getSnapshotCount = 0;
	return {
		subscribe: (cb: (event: HubSessionEvent) => void) => {
			subscribers.push(cb);
			return () => {
				const i = subscribers.indexOf(cb);
				if (i >= 0) {
					subscribers.splice(i, 1);
				}
			};
		},
		getHeader: () => snapshot.header,
		getSnapshot: () => {
			getSnapshotCount += 1;
			return snapshot;
		},
		getSnapshotCount: () => getSnapshotCount,
		recordError: () => {},
		setSnapshot: (next: HubSessionSnapshot) => {
			snapshot = next;
		},
		notify: (event: HubSessionEvent) => {
			for (const s of subscribers) {
				s(event);
			}
		},
	} as unknown as HubSessionServiceWithNotify;
}

function imageIdForPngData(data: string): string {
	return createHash("sha256").update("image/png").update("\0").update(data).digest("hex");
}

function waitForNextCrdtSync(client: ClientSocket): Promise<SessionCrdtSyncPayload> {
	return new Promise((resolve) => {
		client.once("session:crdt_sync", resolve);
	});
}

async function connectClient(port: number): Promise<ClientSocket> {
	const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
		transports: ["websocket"],
		autoConnect: true,
	});
	await new Promise<void>((resolve, reject) => {
		client.on("connect", () => resolve());
		client.on("connect_error", (err) => reject(err));
	});
	return client;
}

async function registerPeer(client: ClientSocket, peerId: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		client.emit(
			"peer:hello",
			{ peerId, token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION },
			(ack: { ok: boolean; error?: string }) => {
				if (ack.ok) {
					resolve();
					return;
				}
				reject(new Error(ack.error ?? "peer:hello failed"));
			},
		);
	});
	await new Promise<void>((resolve, reject) => {
		client.emit("peer:config", {}, (ack: { ok: boolean; error?: string }) => {
			if (ack.ok) {
				resolve();
				return;
			}
			reject(new Error(ack.error ?? "peer:config failed"));
		});
	});
}

function timeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
	});
}

function largeImageToolResult(data = "a".repeat(1_200_000)): AgentToolResult<unknown> {
	return {
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: undefined,
	};
}

type OrderedEvent = { name: "image:payload" | "session:crdt_sync" };
type CompactTestServerInternals = {
	viewDocuments: Map<string, HubViewDocument>;
	pendingCrdtFanoutsByAgentId: Map<string, unknown>;
};

function createCompactPolicyServer(thresholds: SocketHubServerCrdtCompactThresholds): SocketHubServer {
	const session = createStubSessionService();
	const peerRegistry = new PeerRegistry();
	const binding: HubAgentSocketBinding = {
		sessionService: session,
		peerRegistry,
		tools: [],
		agentAdapter: {} as HubAgentAdapter,
	};
	const deps: ConstructorParameters<typeof SocketHubServer>[0] = {
		getDefaultAgentId: () => MAIN_AGENT_ID,
		getAgentIds: () => [MAIN_AGENT_ID],
		getAgentRuntime: (agentId) => (agentId === MAIN_AGENT_ID ? binding : undefined),
		getAgentMetadata: () => ({ kind: "root", lifecycle: "persistent" }),
		authenticateToken: (token) =>
			token
				? {
						id: "test-root",
						name: "root",
						description: "Test root identity",
						user: "test-user",
						purpose: "test access",
						scopeRootAgentId: MAIN_AGENT_ID,
						createdByAgentId: MAIN_AGENT_ID,
						root: true,
					}
				: undefined,
		isAgentInScope: (identity, targetAgentId) =>
			identity.scopeRootAgentId === MAIN_AGENT_ID && targetAgentId === MAIN_AGENT_ID,
		getHttpSessionService: () => session,
		subscribeAllAgentSessionEvents: () => () => {},
		getSourceStatuses: () => [],
		sourceMutators: {
			pause: async () => undefined,
			restart: async () => undefined,
			remove: async () => undefined,
		},
		getMcpServerStatuses: () => [],
		getMcpConfigError: () => undefined,
		mcpMutators: {
			pauseServer: async () => ({ ok: false, error: "not implemented" }),
			restartServer: async () => ({ ok: false, error: "not implemented" }),
			removeServer: async () => ({ ok: false, error: "not implemented" }),
		},
		crdtCompactThresholds: thresholds,
	};
	return new SocketHubServer(deps);
}

function getCompactView(server: SocketHubServer): HubViewDocument {
	const view = (server as unknown as CompactTestServerInternals).viewDocuments.get(MAIN_AGENT_ID);
	if (!view) {
		throw new Error("Missing compact test view document.");
	}
	return view;
}

function getPendingCrdtFanoutCount(server: SocketHubServer): number {
	return (server as unknown as CompactTestServerInternals).pendingCrdtFanoutsByAgentId.size;
}

describe("socket hub server tool payload sizes", () => {
	it("initializes the CRDT session view during start, not during peer hello", async () => {
		const session = createCountedSessionService();
		const server = createMainOnlySocketHubServer(
			session,
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		expect(session.getSnapshotCount()).toBe(1);
		const client = await connectClient(address.port);

		try {
			const firstSync = waitForNextCrdtSync(client);
			await registerPeer(client, "peer-preinitialized-view");
			await firstSync;
			expect(session.getSnapshotCount()).toBe(1);
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("keeps large peer config snapshots out of CRDT peer list fanout after staged config upload", async () => {
		const session = createStubSessionService();
		const peerRegistry = new PeerRegistry();
		const ordering: string[] = [];
		const mainBinding = {
			sessionService: session,
			peerRegistry,
			tools: [],
			agentAdapter: undefined,
		};
		const server = new SocketHubServer({
			getDefaultAgentId: () => MAIN_AGENT_ID,
			getAgentIds: () => [MAIN_AGENT_ID],
			getAgentRuntime: (id) => (id === MAIN_AGENT_ID ? mainBinding : undefined),
			authenticateToken: () => ({
				id: "test-root",
				name: "root",
				description: "test",
				user: "test-user",
				purpose: "test access",
				scopeRootAgentId: MAIN_AGENT_ID,
				createdByAgentId: MAIN_AGENT_ID,
				root: true,
			}),
			isAgentInScope: (identity, targetAgentId) =>
				identity.scopeRootAgentId === MAIN_AGENT_ID && targetAgentId === MAIN_AGENT_ID,
			getHttpSessionService: () => session,
			subscribeAllAgentSessionEvents: (onEvent) => session.subscribe((event) => onEvent(MAIN_AGENT_ID, event)),
			getSourceStatuses: () => [],
			sourceMutators: {
				pause: async () => undefined,
				restart: async () => undefined,
				remove: async () => undefined,
			},
			getMcpServerStatuses: () => [],
			getMcpConfigError: () => undefined,
			onPeerConfigSnapshot: () => {
				ordering.push("config");
			},
			mcpMutators: {
				pauseServer: async () => ({ ok: false, error: "unavailable" }),
				restartServer: async () => ({ ok: false, error: "unavailable" }),
				removeServer: async () => ({ ok: false, error: "unavailable" }),
			},
		});
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);

		try {
			let doc = Automerge.init();
			let syncState = Automerge.initSyncState();
			const firstSync = new Promise<void>((resolve) => {
				client.once("session:crdt_sync", (payload) => {
					ordering.push("crdt");
					const message =
						payload.message instanceof Uint8Array ? payload.message : new Uint8Array(payload.message);
					if (payload.format === "snapshot") {
						doc = Automerge.load(message);
					} else if (payload.format === "incremental") {
						doc = Automerge.loadIncremental(doc, message);
					} else {
						[doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message);
					}
					resolve();
				});
			});
			client.emit(
				"peer:hello",
				{
					peerId: "peer-config-after-first-sync",
					token: "test-token",
					protocolVersion: HUB_PROTOCOL_VERSION,
				},
				(ack: { ok: boolean; error?: string }) => {
					expect(ack).toEqual({ ok: true });
				},
			);
			client.emit(
				"peer:config",
				{
					configSnapshot: {
						version: 1,
						capturedAt: new Date().toISOString(),
						cwd: "/tmp",
						cwdLayer: {
							skills: [
								{
									name: "large-skill",
									description: "Large skill",
									filePath: "/tmp/SKILL.md",
									content: "x".repeat(256_000),
								},
							],
						},
					},
				},
				(ack: { ok: boolean; error?: string }) => {
					expect(ack).toEqual({ ok: true });
				},
			);

			await Promise.race([firstSync, timeout(1_000)]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(ordering).toContain("crdt");
			expect(ordering).toContain("config");
			expect(JSON.stringify(doc)).not.toContain("large-skill");
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("accepts image tool results larger than socket.io's default 1MB payload limit", async () => {
		const server = createMainOnlySocketHubServer(
			createStubSessionService(),
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-large-tool-result");

		try {
			const toolResultPromise = new Promise<AgentToolResult<unknown>>((resolve, reject) => {
				const unsubscribe = server.onToolCallResult((event) => {
					unsubscribe();
					client.off("disconnect", onDisconnect);
					resolve(event.payload.result);
				});
				const onDisconnect = (reason: string) => {
					unsubscribe();
					reject(new Error(`client disconnected before tool result was received: ${reason}`));
				};
				client.once("disconnect", onDisconnect);
			});

			const imageData = "a".repeat(1_200_000);
			client.emit("tool:call_result", {
				toolCallId: "tool-call-large-image",
				result: largeImageToolResult(imageData),
			});

			const result = await Promise.race([toolResultPromise, timeout(1_500)]);
			expect(result.content).toHaveLength(2);
			expect(result.content[1]).toMatchObject({ type: "image", data: imageData, mimeType: "image/png" });
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("initial CRDT sync uses image refs and exposes image bytes only through REST", async () => {
		const imageData = Buffer.from("initial image bytes").toString("base64");
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: "read:1",
			toolName: "read",
			content: largeImageToolResult(imageData).content,
			isError: false,
			timestamp: Date.now(),
		};
		const expectedId = imageIdForPngData(imageData);
		const snapshot = createMinimalSnapshot({
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
		});
		const server = createMainOnlySocketHubServer(
			createStubSessionService(snapshot),
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);

		try {
			const ordered: OrderedEvent[] = [];
			const imagePayloads: unknown[] = [];
			let snapshotCount = 0;
			const firstSync = waitForNextCrdtSync(client);
			client.on("image:payload", (payload) => {
				imagePayloads.push(payload);
				ordered.push({ name: "image:payload" });
			});
			client.on("session:snapshot", () => {
				snapshotCount += 1;
			});
			client.on("session:crdt_sync", () => {
				ordered.push({ name: "session:crdt_sync" });
			});
			await registerPeer(client, "peer-initial-snapshot");
			const sync = await Promise.race([firstSync, timeout(1_500)]);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(imagePayloads).toHaveLength(0);
			const firstSyncIdx = ordered.findIndex((e) => e.name === "session:crdt_sync");
			expect(firstSyncIdx).toBeGreaterThanOrEqual(0);
			expect(snapshotCount).toBe(0);
			expect(JSON.stringify(sync)).not.toContain(imageData);
			expect(JSON.stringify(snapshot)).toContain(imageData);

			const response = await fetch(`http://127.0.0.1:${address.port}/resources/images/${expectedId}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/png");
			const fetchedBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");
			expect(fetchedBase64).toBe(imageData);
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("repeated session updates use CRDT sync and do not re-emit the same image payload to the same socket", async () => {
		const imageData = Buffer.from("repeated image bytes").toString("base64");
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: "read:1",
			toolName: "read",
			content: largeImageToolResult(imageData).content,
			isError: false,
			timestamp: Date.now(),
		};
		const snapshot = createMinimalSnapshot({
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
		});
		const session = createNotifyableSessionService(snapshot);
		const server = createMainOnlySocketHubServer(
			session,
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);

		try {
			let imageCount = 0;
			let snapshotCount = 0;
			client.on("image:payload", () => {
				imageCount += 1;
			});
			client.on("session:snapshot", () => {
				snapshotCount += 1;
			});
			const firstSyncAfterHello = waitForNextCrdtSync(client);
			await registerPeer(client, "peer-rebroadcast");
			await firstSyncAfterHello;
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(imageCount).toBe(0);
			expect(snapshotCount).toBe(0);
			const secondSyncP = waitForNextCrdtSync(client);
			session.notify({
				type: "run_state_changed",
				seq: 1,
				timestamp: new Date().toISOString(),
				isRunning: true,
				runStartedAt: "2026-04-27T00:00:01.000Z",
				lastRunStartedAt: "2026-04-27T00:00:01.000Z",
			});
			await secondSyncP;
			expect(imageCount).toBe(0);
			expect(snapshotCount).toBe(0);
			const thirdSyncP = waitForNextCrdtSync(client);
			session.notify({
				type: "run_state_changed",
				seq: 2,
				timestamp: new Date().toISOString(),
				isRunning: false,
				lastRunStartedAt: "2026-04-27T00:00:01.000Z",
				lastRunEndedAt: "2026-04-27T00:00:02.000Z",
				lastRunDurationMs: 1000,
				lastRunEndReason: "completed",
				runTiming: {
					startedAt: "2026-04-27T00:00:01.000Z",
					endedAt: "2026-04-27T00:00:02.000Z",
					durationMs: 1000,
					endReason: "completed",
				},
			});
			await thirdSyncP;
			expect(imageCount).toBe(0);
			expect(snapshotCount).toBe(0);
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("session fanout applies runtime events without re-reading the full session snapshot", async () => {
		const session = createNotifyableSessionService();
		const server = createMainOnlySocketHubServer(
			session,
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const initialReads = session.getSnapshotCount();
		const client = await connectClient(address.port);
		try {
			await registerPeer(client, "peer-event-no-snapshot");
			const afterHelloReads = session.getSnapshotCount();
			const syncPromise = waitForNextCrdtSync(client);
			session.notify({
				type: "run_state_changed",
				seq: 1,
				timestamp: new Date().toISOString(),
				isRunning: true,
				runStartedAt: "2026-04-27T00:00:01.000Z",
				lastRunStartedAt: "2026-04-27T00:00:01.000Z",
			});
			await syncPromise;
			expect(session.getSnapshotCount()).toBe(afterHelloReads);
			expect(afterHelloReads).toBe(initialReads);
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("multiple peers use the same REST image resource without socket image payloads", async () => {
		const imageData = Buffer.from("shared image bytes").toString("base64");
		const expectedId = imageIdForPngData(imageData);
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: "read:1",
			toolName: "read",
			content: largeImageToolResult(imageData).content,
			isError: false,
			timestamp: Date.now(),
		};
		const snapshot = createMinimalSnapshot({
			entries: [
				{
					type: "message",
					id: "entry",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: toolResultMessage,
				},
			],
			context: { messages: [toolResultMessage], thinkingLevel: "off", model: null },
		});
		const server = createMainOnlySocketHubServer(
			createStubSessionService(snapshot),
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const a = await connectClient(address.port);
		const b = await connectClient(address.port);

		try {
			let imagePayloadCount = 0;
			a.on("image:payload", () => {
				imagePayloadCount += 1;
			});
			b.on("image:payload", () => {
				imagePayloadCount += 1;
			});
			await registerPeer(a, "peer-a");
			await registerPeer(b, "peer-b");
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(imagePayloadCount).toBe(0);
			for (let i = 0; i < 2; i += 1) {
				const response = await fetch(`http://127.0.0.1:${address.port}/resources/images/${expectedId}`);
				expect(response.status).toBe(200);
				expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(imageData);
			}
		} finally {
			a.disconnect();
			b.disconnect();
			await server.stop();
		}
	});

	it("REST image resource returns cached image when available and a clear 404 when missing", async () => {
		const imageData = Buffer.from("rest image bytes").toString("base64");
		const id = imageIdForPngData(imageData);
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: "read:1",
			toolName: "read",
			content: largeImageToolResult(imageData).content,
			isError: false,
			timestamp: Date.now(),
		};
		const snapshot = createMinimalSnapshot({
			entries: [
				{
					type: "message",
					id: "entry",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: toolResultMessage,
				},
			],
			context: { messages: [toolResultMessage], thinkingLevel: "off", model: null },
		});
		const server = createMainOnlySocketHubServer(
			createStubSessionService(snapshot),
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);

		try {
			await registerPeer(client, "peer-image-get");
			const good = await fetch(`http://127.0.0.1:${address.port}/resources/images/${id}`);
			expect(good.status).toBe(200);
			expect(good.headers.get("content-type")).toBe("image/png");
			expect(Buffer.from(await good.arrayBuffer()).toString("base64")).toBe(imageData);

			const bad = await fetch(`http://127.0.0.1:${address.port}/resources/images/${"0".repeat(64)}`);
			expect(bad.status).toBe(404);
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("REST image resource rejects empty image ids before cache lookup", async () => {
		const server = createMainOnlySocketHubServer(
			createStubSessionService(),
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const unregistered = await connectClient(address.port);
		const registered = await connectClient(address.port);
		try {
			await registerPeer(registered, "peer-empty-id");
			const response = await fetch(`http://127.0.0.1:${address.port}/resources/images/`);
			expect(response.status).toBe(404);
		} finally {
			unregistered.disconnect();
			registered.disconnect();
			await server.stop();
		}
	});

	it("CRDT live tool_execution_end sync contains only refs and exposes bytes through REST", async () => {
		const imageData = Buffer.from("live image bytes").toString("base64");
		const expectedId = imageIdForPngData(imageData);
		const server = createMainOnlySocketHubServer(
			createStubSessionService(),
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);

		try {
			const ordered: OrderedEvent[] = [];
			const payloads: unknown[] = [];
			await registerPeer(client, "peer-live");
			await new Promise((resolve) => setTimeout(resolve, 50));
			client.on("image:payload", (p) => {
				payloads.push(p);
				ordered.push({ name: "image:payload" });
			});
			client.on("session:crdt_sync", () => {
				ordered.push({ name: "session:crdt_sync" });
			});
			const syncPromise = new Promise<unknown>((resolve) => {
				client.once("session:crdt_sync", resolve);
			});
			server.broadcastLiveEvent(MAIN_AGENT_ID, {
				type: "tool_execution_end",
				toolCallId: "read:1",
				toolName: "read",
				result: largeImageToolResult(imageData),
				isError: false,
			});
			const sync = await Promise.race([syncPromise, timeout(1_500)]);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(payloads).toHaveLength(0);
			const firstSync = ordered.findIndex((e) => e.name === "session:crdt_sync");
			expect(firstSync).toBeGreaterThanOrEqual(0);
			expect(JSON.stringify(sync)).not.toContain(imageData);
			const response = await fetch(`http://127.0.0.1:${address.port}/resources/images/${expectedId}`);
			expect(response.status).toBe(200);
			expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(imageData);
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("compacts CRDT history without fanout when no peers are connected", async () => {
		const server = createCompactPolicyServer({ idleChangeCount: 4, activeChangeCount: 100 });
		await server.start({ host: "127.0.0.1", port: 0 });
		try {
			for (let i = 0; i < 8; i += 1) {
				server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: `idle-${i}` });
			}

			// Compaction is throttled (~500ms) so we wait for the timer to fire.
			await vi.waitFor(
				() => {
					expect(getCompactView(server).getChangeCount()).toBeLessThanOrEqual(4);
				},
				{ timeout: 2_000 },
			);
			expect(getCompactView(server).getSnapshot().agentsById[MAIN_AGENT_ID]?.live.statusMessage).toBe("idle-7");
			expect(getPendingCrdtFanoutCount(server)).toBe(0);
		} finally {
			await server.stop();
		}
	});

	it("forces a fresh CRDT snapshot for connected peers after active history compaction", async () => {
		const server = createCompactPolicyServer({ idleChangeCount: 100, activeChangeCount: 4 });
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		try {
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			client.on("session:crdt_sync", (payload) => {
				syncPayloads.push(payload);
			});
			await registerPeer(client, "peer-active-compact");
			await viWaitForSyncPayload(syncPayloads);
			syncPayloads.length = 0;

			for (let i = 0; i < 8; i += 1) {
				server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: `active-${i}` });
			}

			// Compaction is throttled (~500ms); after it fires the next fanout is a fresh snapshot.
			await vi.waitFor(
				() => {
					expect(syncPayloads.some((payload) => payload.format === "snapshot")).toBe(true);
				},
				{ timeout: 2_000 },
			);
			const snapshotPayload = syncPayloads.find((payload) => payload.format === "snapshot");
			expect(snapshotPayload).toBeDefined();
			const snapshot = Automerge.load<HubViewDocumentState>(snapshotPayload!.message);
			expect(snapshot.agentsById[MAIN_AGENT_ID]?.live.statusMessage).toBe("active-7");
		} finally {
			client.disconnect();
			await server.stop();
		}
	});

	it("keeps CRDT fanout incremental while compact thresholds are not reached", async () => {
		const server = createCompactPolicyServer({ idleChangeCount: 100, activeChangeCount: 100 });
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		try {
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			client.on("session:crdt_sync", (payload) => {
				syncPayloads.push(payload);
			});
			await registerPeer(client, "peer-incremental-compact");
			await viWaitForSyncPayload(syncPayloads);
			syncPayloads.length = 0;

			server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: "under-threshold" });

			await viWaitForSyncPayload(syncPayloads);
			expect(syncPayloads[0]?.format).toBe("incremental");
		} finally {
			client.disconnect();
			await server.stop();
		}
	});
});

async function viWaitForSyncPayload(payloads: SessionCrdtSyncPayload[]): Promise<void> {
	await vi.waitFor(
		() => {
			expect(payloads.length).toBeGreaterThan(0);
		},
		{ timeout: 2_000 },
	);
}
