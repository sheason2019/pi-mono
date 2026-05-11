import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Automerge from "@automerge/automerge";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { type AgentRecord, MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { CHILD_AGENT_DIR_NAME, getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import type { PeerConfigPayload } from "../../src/hub/peers/peer-types.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import type { HubViewDocumentState } from "../../src/hub/session/hub-view-document.js";
import type { LiveRenderEvent } from "../../src/hub/transport/live-events.js";
import { HUB_PROTOCOL_VERSION, type SessionCrdtSyncPayload } from "../../src/hub/transport/protocol.js";
import type { SocketHubServer } from "../../src/hub/transport/socket-hub-server.js";
import { getAgentSessionFile, initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function imageIdForPngData(data: string): string {
	return createHash("sha256").update("image/png").update("\0").update(data).digest("hex");
}

function largeImageForLive(data: string): AgentToolResult<unknown> {
	return {
		content: [
			{ type: "text", text: "Read" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: undefined,
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function headerLine(id: string, cwd: string): string {
	return JSON.stringify({
		type: "session" as const,
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	});
}

type TestAgentRecord = Omit<AgentRecord, "parentId" | "lifecycle"> &
	Partial<Pick<AgentRecord, "parentId" | "lifecycle">>;

function seedRegistryWithChild(cwd: string, child: TestAgentRecord): void {
	const mainSession = getSessionFile(cwd);
	const main: AgentRecord = {
		id: MAIN_AGENT_ID,
		kind: "root",
		sessionFile: mainSession,
		createdAt: new Date(0).toISOString(),
		lifecycle: "persistent",
	};
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeJson(getAgentsConfigPath(cwd), {
		version: 2 as const,
		agents: [
			main,
			{ ...child, parentId: child.parentId ?? MAIN_AGENT_ID, lifecycle: child.lifecycle ?? "persistent" },
		],
	});
}

async function connectClient(addressBase: string): Promise<ClientSocket> {
	const client: ClientSocket = ioClient(addressBase, {
		transports: ["websocket"],
		autoConnect: true,
	});
	await new Promise<void>((resolve, reject) => {
		client.on("connect", () => resolve());
		client.on("connect_error", (err) => reject(err));
	});
	return client;
}

function peerHello(
	client: ClientSocket,
	payload: {
		peerId: string;
		agentId?: string;
		protocolVersion?: number;
		clientKind?: "peer" | "host";
		token?: string;
	},
	options: { configure?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve, reject) => {
		client.emit(
			"peer:hello",
			{ token: currentRootToken, protocolVersion: HUB_PROTOCOL_VERSION, ...payload },
			(ack: { ok: boolean; error?: string }) => {
				if (!ack.ok || payload.clientKind === "host" || options.configure === false) {
					resolve(ack);
					return;
				}
				client.emit("peer:config", {}, (configAck: { ok: boolean; error?: string }) => {
					if (configAck.ok) {
						resolve(ack);
						return;
					}
					reject(new Error(configAck.error ?? "peer:config failed"));
				});
			},
		);
	});
}

function peerConfig(client: ClientSocket, payload: PeerConfigPayload): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		client.emit("peer:config", payload, (ack: { ok: boolean; error?: string }) => resolve(ack));
	});
}

function peerHelloOnly(
	client: ClientSocket,
	payload: {
		peerId: string;
		agentId?: string;
		protocolVersion?: number;
		clientKind?: "peer" | "host";
		token?: string;
	},
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		client.emit(
			"peer:hello",
			{ token: currentRootToken, protocolVersion: HUB_PROTOCOL_VERSION, ...payload },
			(ack: { ok: boolean; error?: string }) => resolve(ack),
		);
	});
}

function getHubViewDoc(crdt: { getDoc: () => Automerge.Doc<unknown> }): { agentOrder?: string[] } {
	return crdt.getDoc() as { agentOrder?: string[] };
}

function toUint8Array(value: SessionCrdtSyncPayload["message"]): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function installCrdtSyncEcho(
	client: ClientSocket,
	payloads: SessionCrdtSyncPayload[],
): { getDoc: () => Automerge.Doc<unknown> } {
	let peerDoc = Automerge.init<unknown>();
	client.on("session:crdt_sync", (payload: SessionCrdtSyncPayload) => {
		payloads.push(payload);
		const message = toUint8Array(payload.message);
		if (payload.format === "snapshot") {
			peerDoc = Automerge.load(message);
			return;
		}
		if (payload.format === "incremental") {
			peerDoc = Automerge.loadIncremental(peerDoc, message);
			return;
		}
		const [nextDoc] = Automerge.receiveSyncMessage(peerDoc, Automerge.initSyncState(), message);
		peerDoc = nextDoc;
	});
	return { getDoc: () => peerDoc };
}

function createLegacySyncMessageWithChanges(doc: Automerge.Doc<HubViewDocumentState>): Uint8Array {
	let clientSync = Automerge.initSyncState();
	let serverDoc = Automerge.init<HubViewDocumentState>();
	let serverSync = Automerge.initSyncState();
	const [nextClientSync, message] = Automerge.generateSyncMessage(doc, clientSync);
	clientSync = nextClientSync;
	if (!message) {
		throw new Error("Expected initial legacy sync message.");
	}
	[serverDoc, serverSync] = Automerge.receiveSyncMessage(serverDoc, serverSync, message);
	const [nextServerSync, serverNeed] = Automerge.generateSyncMessage(serverDoc, serverSync);
	serverSync = nextServerSync;
	if (!serverNeed) {
		throw new Error("Expected legacy sync need message.");
	}
	const [syncedDoc, syncedClientSync] = Automerge.receiveSyncMessage(doc, clientSync, serverNeed);
	const [finalClientSync, messageWithChanges] = Automerge.generateSyncMessage(syncedDoc, syncedClientSync);
	clientSync = finalClientSync;
	if (!messageWithChanges || Automerge.decodeSyncMessage(messageWithChanges).changes.length === 0) {
		throw new Error("Expected legacy sync message with changes.");
	}
	expect(clientSync).toBeDefined();
	expect(serverSync).toBeDefined();
	return messageWithChanges;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("SocketHubServer agent binding (peer:hello / routing)", () => {
	it("rejects peer config before hello", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-config-before-hello-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		try {
			expect(await peerConfig(client, { tools: ["read"] })).toEqual({ ok: false, error: "Peer is not registered." });
		} finally {
			client.close();
			await hub.stop();
		}
	});

	it("accepts peer config after hello and then syncs the peer view", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-config-after-hello-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const syncPayloads: SessionCrdtSyncPayload[] = [];
		const crdt = installCrdtSyncEcho(client, syncPayloads);
		try {
			expect(await peerHello(client, { peerId: "config-peer" }, { configure: false })).toEqual({ ok: true });
			expect(hub.getRootAgentRuntime().peerRegistry.get("config-peer")?.tools).toEqual([]);
			expect(syncPayloads).toHaveLength(0);

			expect(
				await peerConfig(client, {
					tools: ["bash", "read"],
					configSnapshot: {
						version: 1,
						capturedAt: "2026-05-08T00:00:00.000Z",
						cwd: "/peer",
						global: {
							skills: [
								{
									name: "large-skill",
									description: "large skill",
									filePath: "/peer/SKILL.md",
									content: "x".repeat(300_000),
								},
							],
						},
					},
				}),
			).toEqual({ ok: true });

			expect(hub.getRootAgentRuntime().peerRegistry.get("config-peer")?.tools).toEqual(["bash", "read"]);
			await vi.waitFor(() => expect(syncPayloads.length).toBeGreaterThan(0));
			const doc = crdt.getDoc() as HubViewDocumentState;
			expect(doc.peers.find((peer) => peer.peerId === "config-peer")?.tools).toEqual(["bash", "read"]);
		} finally {
			client.close();
			await hub.stop();
		}
	});

	it("requires peer config upload again after reconnecting the same peer id", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-config-reconnect-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;
		const first = await connectClient(base);
		try {
			expect(await peerHelloOnly(first, { peerId: "reconnect-peer" })).toEqual({ ok: true });
			expect(await peerConfig(first, { tools: ["bash", "read"] })).toEqual({ ok: true });
		} finally {
			first.close();
		}

		const second = await connectClient(base);
		const syncPayloads: SessionCrdtSyncPayload[] = [];
		const crdt = installCrdtSyncEcho(second, syncPayloads);
		try {
			expect(await peerHelloOnly(second, { peerId: "reconnect-peer" })).toEqual({ ok: true });
			expect(hub.getRootAgentRuntime().peerRegistry.get("reconnect-peer")?.tools).toEqual([]);
			expect(await peerConfig(second, { tools: ["bash", "read"] })).toEqual({ ok: true });
			await vi.waitFor(() => expect(syncPayloads.length).toBeGreaterThan(0));
			const doc = crdt.getDoc() as HubViewDocumentState;
			expect(doc.peers.find((peer) => peer.peerId === "reconnect-peer")?.tools).toEqual(["bash", "read"]);
		} finally {
			second.close();
			await hub.stop();
		}
	});

	it("rejects missing, invalid, and out-of-scope auth tokens", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-auth-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		socketServer(hub);
		const base = `http://127.0.0.1:${address.port}`;
		const missing = await connectClient(base);
		const invalid = await connectClient(base);
		const scoped = await connectClient(base);
		try {
			expect(await peerHello(missing, { peerId: "missing-token", token: "" })).toEqual({
				ok: false,
				error: "Authentication token is required.",
			});
			expect(await peerHello(invalid, { peerId: "invalid-token", token: "wrong-token" })).toEqual({
				ok: false,
				error: "Invalid authentication token.",
			});
			const childToken = hub.authTokenStore.createScopedToken({
				name: "child",
				description: "child only",
				user: "test-user",
				purpose: "test access",
				scopeRootAgentId: "child-a",
				createdByAgentId: "child-a",
			});
			expect(await peerHello(scoped, { peerId: "scoped-parent", token: childToken.token })).toEqual({
				ok: false,
				error: "Token scope does not allow access to agent id: root",
			});
		} finally {
			missing.close();
			invalid.close();
			scoped.close();
			await hub.stop();
		}
	});

	it("disconnects peers immediately when their auth token is revoked", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-auth-revoke-disconnect-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		const token = hub.authTokenStore.createScopedToken({
			name: "root guest",
			description: "Root guest access",
			user: "test-user",
			purpose: "test access",
			scopeRootAgentId: MAIN_AGENT_ID,
			createdByAgentId: MAIN_AGENT_ID,
		});
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const disconnected = new Promise<string>((resolve) => {
			client.once("disconnect", resolve);
		});
		try {
			expect(await peerHello(client, { peerId: "revoked-peer", token: token.token })).toEqual({ ok: true });
			expect(hub.getRootAgentRuntime().peerRegistry.get("revoked-peer")).toBeDefined();

			const revokedText = await hub.revokeAgentTokenText(MAIN_AGENT_ID, { tokenId: token.record.id });

			expect(JSON.parse(revokedText)).toEqual(
				expect.objectContaining({ ok: true, tokenId: token.record.id, revokedConnections: 1 }),
			);
			await expect(disconnected).resolves.toBe("io server disconnect");
			expect(hub.getRootAgentRuntime().peerRegistry.get("revoked-peer")).toBeUndefined();
		} finally {
			client.close();
			await hub.stop();
		}
	});

	it("host UI without an explicit agentId binds to the scoped token creator agent", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-host-scoped-default-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-scoped");
		writeFileSync(childPath, `${headerLine("child-scoped-session", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-scoped",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		const token = hub.authTokenStore.createScopedToken({
			name: "child scoped",
			description: "host ui child access",
			user: "test-user",
			purpose: "test access",
			scopeRootAgentId: "child-scoped",
			createdByAgentId: "child-scoped",
		}).token;
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const welcome = new Promise<{ agentId: string; scopeRootAgentId: string }>((resolve) =>
			client.once("hub:welcome", resolve),
		);

		const ack = await peerHello(client, { peerId: "host-child-default", clientKind: "host", token });

		expect(ack).toEqual({ ok: true });
		expect(await welcome).toEqual(
			expect.objectContaining({ agentId: "child-scoped", scopeRootAgentId: "child-scoped" }),
		);
		client.close();
		await hub.stop();
	});

	it("uses a heartbeat timeout that tolerates expensive peer-side CRDT rendering", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-heartbeat-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		try {
			await hub.initializeAgentAdapter();
			await hub.start({ host: "127.0.0.1", port: 0 });

			const internals = socketServer(hub) as unknown as {
				io?: { engine?: { opts?: { pingTimeout?: number; pingInterval?: number } } };
			};

			expect(internals.io?.engine?.opts?.pingInterval).toBeLessThanOrEqual(10_000);
			expect(internals.io?.engine?.opts?.pingTimeout).toBeGreaterThanOrEqual(300_000);
		} finally {
			await hub.stop().catch(() => {});
		}
	});

	it("peer hello without agentId binds to main and syncs initial state through CRDT only", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-default-main-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
		const hub = HubRuntime.open(workspaceDir, { logs });
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const mainId = hub.getRootAgentRuntime().sessionService.getHeader().id;
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const welcomePromise = new Promise<{ agentId: string }>((resolve) => {
			client.once("hub:welcome", resolve);
		});
		const crdtPayloads: SessionCrdtSyncPayload[] = [];
		let snapshotCount = 0;
		client.on("session:crdt_sync", (payload) => crdtPayloads.push(payload));
		client.on("session:snapshot", () => {
			snapshotCount += 1;
		});
		const ack = await peerHello(client, { peerId: "p-default" });
		expect(ack).toEqual({ ok: true });
		const welcome = await welcomePromise;
		await vi.waitFor(() => {
			expect(crdtPayloads.length).toBeGreaterThan(0);
		});
		expect(welcome.agentId).toBe(MAIN_AGENT_ID);
		expect(snapshotCount).toBe(0);
		expect(mainId).toBeDefined();
		expect(logs.info).toHaveBeenCalledWith("peer connected", {
			agentId: MAIN_AGENT_ID,
			peerId: "p-default",
		});
		hub.getRootAgentRuntime().sessionService.recordError("adapter exploded");
		expect(logs.error).toHaveBeenCalledWith("agent error", {
			agentId: MAIN_AGENT_ID,
			error: "adapter exploded",
		});
		expect(logs.info.mock.calls).not.toEqual(
			expect.arrayContaining([["socket fanout timing", expect.objectContaining({ eventType: "session:event" })]]),
		);
		client.close();
		await vi.waitFor(() => {
			expect(logs.info).toHaveBeenCalledWith(
				"peer disconnected",
				expect.objectContaining({
					agentId: MAIN_AGENT_ID,
					peerId: "p-default",
					reason: expect.any(String),
				}),
			);
		});
		await hub.stop();
	});

	it("syncs snapshot_updated session fields to already connected CRDT peers", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-snapshot-update-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const crdtPayloads: SessionCrdtSyncPayload[] = [];
		const crdt = installCrdtSyncEcho(client, crdtPayloads);
		const ack = await peerHello(client, { peerId: "snapshot-update-peer" });
		expect(ack).toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(
				(crdt.getDoc() as { agentsById?: { root?: { sessionId?: string } } }).agentsById?.root?.sessionId,
			).toBeDefined();
		});

		hub.getRootAgentRuntime().sessionService.updateDiagnostics(["fresh diagnostic"]);

		await vi.waitFor(() => {
			expect(
				(crdt.getDoc() as { agentsById?: { root?: { diagnostics?: string[] } } }).agentsById?.root?.diagnostics,
			).toEqual(["fresh diagnostic"]);
		});
		client.close();
		await hub.stop();
	});

	it("peer hello with child agentId syncs that agent through CRDT only", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-child-snap-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-a");
		writeFileSync(childPath, `${headerLine("child-sess-xyz", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-a",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const welcomePromise = new Promise<{ agentId: string }>((resolve) => {
			client.once("hub:welcome", resolve);
		});
		const crdtPayloads: SessionCrdtSyncPayload[] = [];
		let snapshotCount = 0;
		client.on("session:crdt_sync", (payload) => crdtPayloads.push(payload));
		client.on("session:snapshot", () => {
			snapshotCount += 1;
		});
		const ack = await peerHello(client, { peerId: "p-child", agentId: "child-a" });
		expect(ack).toEqual({ ok: true });
		const childHeaderId = hub.getAgentRuntime("child-a").sessionService.getHeader().id;
		const welcome = await welcomePromise;
		await vi.waitFor(() => {
			expect(crdtPayloads.length).toBeGreaterThan(0);
		});
		expect(welcome.agentId).toBe("child-a");
		expect(snapshotCount).toBe(0);
		expect(childHeaderId).toBeDefined();
		client.close();
		await hub.stop();
	});

	it("host UI bound to main receives all existing agent ids for the Web agent switcher", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-host-agent-list-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-a");
		writeFileSync(childPath, `${headerLine("child-sess-list", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-a",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const crdtPayloads: SessionCrdtSyncPayload[] = [];
		const crdt = installCrdtSyncEcho(client, crdtPayloads);

		const ack = await peerHello(client, { peerId: "web-host", clientKind: "host" });
		expect(ack).toEqual({ ok: true });

		await vi.waitFor(() => {
			expect(getHubViewDoc(crdt).agentOrder).toEqual([MAIN_AGENT_ID, "child-a"]);
		});
		client.close();
		await hub.stop();
	});

	it("emits CRDT sync messages for initial and updated bound session state", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-crdt-sync-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const crdtPayloads: SessionCrdtSyncPayload[] = [];
		let snapshotCount = 0;
		client.on("session:crdt_sync", (payload: SessionCrdtSyncPayload) => {
			crdtPayloads.push(payload);
		});
		client.on("session:snapshot", () => {
			snapshotCount += 1;
		});

		expect(await peerHello(client, { peerId: "p-crdt" })).toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(crdtPayloads.length).toBeGreaterThan(0);
		});
		expect(snapshotCount).toBe(0);
		const initialCount = crdtPayloads.length;
		hub.getRootAgentRuntime().sessionService.setRunState(true);
		await vi.waitFor(() => {
			expect(crdtPayloads.length).toBeGreaterThan(initialCount);
		});
		expect(snapshotCount).toBe(0);

		client.close();
		await hub.stop();
	});

	it("unknown agentId rejects peer:hello with a clear error", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-unknown-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const ack = await peerHello(client, { peerId: "p-x", agentId: "no-such-agent" });
		expect(ack.ok).toBe(false);
		expect(ack.error).toMatch(/Unknown agent id: no-such-agent/);
		client.close();
		await hub.stop();
	});

	it("peer list changes sync through CRDT only and do not emit hub:peers_changed", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-peers-changed-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-b");
		writeFileSync(childPath, `${headerLine("child-sess-b", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-b",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;

		const mainClient = await connectClient(base);
		const childClient = await connectClient(base);
		const mainEvents: string[][] = [];
		const childEvents: string[][] = [];
		const mainSync: SessionCrdtSyncPayload[] = [];
		const childSync: SessionCrdtSyncPayload[] = [];
		mainClient.on("hub:peers_changed", (pl: { peers: { peerId: string }[] }) => {
			mainEvents.push(pl.peers.map((p) => p.peerId).sort());
		});
		childClient.on("hub:peers_changed", (pl: { peers: { peerId: string }[] }) => {
			childEvents.push(pl.peers.map((p) => p.peerId).sort());
		});
		mainClient.on("session:crdt_sync", (payload) => mainSync.push(payload));
		childClient.on("session:crdt_sync", (payload) => childSync.push(payload));

		const ma = await peerHello(mainClient, { peerId: "m-peer" });
		const ca = await peerHello(childClient, { peerId: "c-peer", agentId: "child-b" });
		expect(ma).toEqual({ ok: true });
		expect(ca).toEqual({ ok: true });

		await vi.waitFor(
			() => {
				expect(mainSync.length).toBeGreaterThan(0);
				expect(childSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);

		expect(mainEvents).toHaveLength(0);
		expect(childEvents).toHaveLength(0);

		mainClient.close();
		childClient.close();
		await hub.stop();
	});

	it("session:queue_write from a child-bound socket is handled by the child agent adapter, not main", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-prompt-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-c");
		writeFileSync(childPath, `${headerLine("child-sess-c", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-c",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const mainQueueWrite = vi.fn().mockResolvedValue(undefined);
		const childQueueWrite = vi.fn().mockResolvedValue(undefined);
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			if (createN === 1) {
				return {
					subscribeLiveEvents: () => () => {},
					enqueueFromPeer: mainQueueWrite,
					dispose: () => {},
				} as unknown as HubAgentAdapter;
			}
			return {
				subscribeLiveEvents: () => () => {},
				enqueueFromPeer: childQueueWrite,
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const ackH = await peerHello(client, { peerId: "p-prompt", agentId: "child-c" });
		expect(ackH.ok).toBe(true);

		const pr = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			client.emit("session:queue_write", { text: "hi" }, resolve);
		});
		expect(pr.ok).toBe(true);

		expect(mainQueueWrite).not.toHaveBeenCalled();
		expect(childQueueWrite).toHaveBeenCalledWith(
			"p-prompt",
			"hi",
			expect.objectContaining({
				sentAt: expect.any(String),
			}),
		);
		client.close();
		await hub.stop();
	});

	it("child peer registry does not include main-registered peers", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-list-isolation-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-d");
		writeFileSync(childPath, `${headerLine("child-sess-d", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-d",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;

		const m = await connectClient(base);
		const c = await connectClient(base);
		await peerHello(m, { peerId: "only-main" });
		await peerHello(c, { peerId: "only-child", agentId: "child-d" });
		// Same data `group` exposes: per-agent registries stay isolated.
		const mainPeerIds = hub
			.getRootAgentRuntime()
			.peerRegistry.list()
			.map((p) => p.peerId)
			.sort();
		const childPeerIds = hub
			.getAgentRuntime("child-d")
			.peerRegistry.list()
			.map((p) => p.peerId)
			.sort();
		expect(mainPeerIds).toEqual(["only-main"]);
		expect(childPeerIds).toEqual(["only-child"]);
		m.close();
		c.close();
		await hub.stop();
	});

	it("rejects a second peer:hello on the same socket and does not rebind", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-hello-2-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const welcomes: unknown[] = [];
		client.on("hub:welcome", (p) => welcomes.push(p));
		const first = await peerHello(client, { peerId: "rebind-a" });
		expect(first).toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(welcomes).toHaveLength(1);
		});
		const second = await peerHello(client, { peerId: "rebind-b", agentId: "root" });
		expect(second.ok).toBe(false);
		if (second.ok) {
			return;
		}
		expect(second.error).toMatch(/already bound/);
		expect(welcomes).toHaveLength(1);
		expect(hub.getRootAgentRuntime().peerRegistry.get("rebind-b")).toBeUndefined();
		expect(hub.getRootAgentRuntime().peerRegistry.get("rebind-a")?.peerId).toBe("rebind-a");
		const lateSnap = await new Promise<unknown | null>((resolve) => {
			const t = setTimeout(() => resolve(null), 200);
			client.once("session:snapshot", (s) => {
				clearTimeout(t);
				resolve(s);
			});
		});
		expect(lateSnap).toBeNull();
		client.close();
		await hub.stop();
	});
});

type HubTestInternals = { socketServer: SocketHubServer };
let currentRootToken = "test-token";

function socketServer(hub: HubRuntime): SocketHubServer {
	currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
	return (hub as unknown as HubTestInternals).socketServer;
}

function setupHubWithChild(childId: string, headerId: string): { workspaceDir: string } {
	const workspaceDir = mkdtempSync(join(tmpdir(), `hub-${childId}-`));
	tempDirs.push(workspaceDir);
	initializeWorkspace(workspaceDir);
	mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
	const childPath = getAgentSessionFile(workspaceDir, childId);
	writeFileSync(childPath, `${headerLine(headerId, workspaceDir)}\n`, "utf8");
	seedRegistryWithChild(workspaceDir, {
		id: childId,
		kind: "child",
		sessionFile: childPath,
		createdAt: new Date(0).toISOString(),
	});
	return { workspaceDir };
}

describe("SocketHubServer cross-agent event scoping and child routing (hardening)", () => {
	it("session updates sync through CRDT only and do not emit session:event", async () => {
		const { workspaceDir } = setupHubWithChild("child-evt", "sess-evt");
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;
		const m = await connectClient(base);
		const c = await connectClient(base);
		let mainSessionEvents = 0;
		let childSessionEvents = 0;
		const mainSync: SessionCrdtSyncPayload[] = [];
		const childSync: SessionCrdtSyncPayload[] = [];
		m.on("session:event", () => {
			mainSessionEvents += 1;
		});
		c.on("session:event", () => {
			childSessionEvents += 1;
		});
		m.on("session:crdt_sync", (payload) => mainSync.push(payload));
		c.on("session:crdt_sync", (payload) => childSync.push(payload));
		await peerHello(m, { peerId: "e-main" });
		await peerHello(c, { peerId: "e-child", agentId: "child-evt" });
		await vi.waitFor(
			() => {
				expect(mainSync.length).toBeGreaterThan(0);
				expect(childSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		mainSync.length = 0;
		childSync.length = 0;
		hub.getRootAgentRuntime().sessionService.setRunState(true);
		await vi.waitFor(
			() => {
				expect(mainSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		expect(childSync).toHaveLength(0);
		expect(mainSessionEvents).toBe(0);
		expect(childSessionEvents).toBe(0);
		mainSync.length = 0;
		childSync.length = 0;
		hub.getAgentRuntime("child-evt").sessionService.setRunState(true);
		await vi.waitFor(
			() => {
				expect(childSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		expect(mainSync).toHaveLength(0);
		expect(mainSessionEvents).toBe(0);
		expect(childSessionEvents).toBe(0);
		m.close();
		c.close();
		await hub.stop();
	});

	it("session:crdt_sync for live updates is only delivered to the bound agent", async () => {
		const { workspaceDir } = setupHubWithChild("child-live", "sess-live");
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;
		const m = await connectClient(base);
		const c = await connectClient(base);
		const mainSync: SessionCrdtSyncPayload[] = [];
		const childSync: SessionCrdtSyncPayload[] = [];
		m.on("session:crdt_sync", (e) => mainSync.push(e));
		c.on("session:crdt_sync", (e) => childSync.push(e));
		await peerHello(m, { peerId: "l-main" });
		await peerHello(c, { peerId: "l-child", agentId: "child-live" });
		await vi.waitFor(
			() => {
				expect(mainSync.length).toBeGreaterThan(0);
				expect(childSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		mainSync.length = 0;
		childSync.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 50));
		mainSync.length = 0;
		childSync.length = 0;
		const ev: LiveRenderEvent = { type: "status", message: "only-main" };
		socketServer(hub).broadcastLiveEvent(MAIN_AGENT_ID, ev);
		await vi.waitFor(
			() => {
				expect(mainSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		expect(childSync).toHaveLength(0);
		mainSync.length = 0;
		childSync.length = 0;
		socketServer(hub).broadcastLiveEvent("child-live", { type: "status", message: "only-child" });
		await vi.waitFor(
			() => {
				expect(childSync.length).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		expect(mainSync).toHaveLength(0);
		m.close();
		c.close();
		await hub.stop();
	});

	it("logs Socket.IO peer event payloads as aggregate fanout metrics", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-socket-log-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
		const hub = HubRuntime.open(workspaceDir, { logs });
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		let client: ClientSocket | undefined;
		try {
			await hub.initializeAgentAdapter();
			const address = await hub.start({ host: "127.0.0.1", port: 0 });
			client = await connectClient(`http://127.0.0.1:${address.port}`);
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			installCrdtSyncEcho(client, syncPayloads);
			await peerHello(client, { peerId: "socket-log" });
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			logs.info.mockClear();

			socketServer(hub).broadcastLiveEvent(MAIN_AGENT_ID, {
				type: "status",
				message: Array.from({ length: 60_000 }, (_, index) => `line-${index}-${index.toString(36)}`).join("\n"),
			});

			await vi.waitFor(
				() => {
					expect(logs.info).toHaveBeenCalledWith(
						"socket fanout timing",
						expect.objectContaining({
							eventType: "session:crdt_sync",
							eventCount: expect.any(Number),
							payloadTotalBytes: expect.any(Number),
							payloadMaxBytes: expect.any(Number),
							payloadAverageBytes: expect.any(Number),
						}),
					);
				},
				{ timeout: 2000 },
			);
		} finally {
			client?.close();
			await hub.stop().catch(() => {});
		}
	});

	it("ignores legacy host UI CRDT acknowledgements without advancing hub state", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-host-crdt-ack-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
		const hub = HubRuntime.open(workspaceDir, { logs });
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		let client: ClientSocket | undefined;
		try {
			await hub.initializeAgentAdapter();
			const address = await hub.start({ host: "127.0.0.1", port: 0 });
			client = await connectClient(`http://127.0.0.1:${address.port}`);
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			installCrdtSyncEcho(client, syncPayloads);

			const ack = await peerHello(client, { peerId: "web-test", clientKind: "host" });
			expect(ack).toEqual({ ok: true });
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(logs.warning).not.toHaveBeenCalledWith(
				"crdt sync rejected",
				expect.objectContaining({
					agentId: MAIN_AGENT_ID,
				}),
			);
		} finally {
			client?.close();
			await hub.stop().catch(() => {});
		}
	});

	it("rejects client CRDT sync messages that contain document changes", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-client-crdt-change-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
		const hub = HubRuntime.open(workspaceDir, { logs });
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		let client: ClientSocket | undefined;
		try {
			await hub.initializeAgentAdapter();
			const address = await hub.start({ host: "127.0.0.1", port: 0 });
			client = await connectClient(`http://127.0.0.1:${address.port}`);
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			const crdt = installCrdtSyncEcho(client, syncPayloads);
			const ack = await peerHello(client, { peerId: "web-change", clientKind: "host" });
			expect(ack).toEqual({ ok: true });
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);

			await vi.waitFor(
				() => {
					expect((crdt.getDoc() as HubViewDocumentState).agentsById?.[MAIN_AGENT_ID]).toBeDefined();
				},
				{ timeout: 2000 },
			);
			const changed = Automerge.change<HubViewDocumentState>(
				crdt.getDoc() as Automerge.Doc<HubViewDocumentState>,
				(doc) => {
					doc.agentsById[MAIN_AGENT_ID]!.status.isRunning = true;
				},
			);
			const changeMessage = createLegacySyncMessageWithChanges(changed);
			client.emit("session:crdt_sync", { message: changeMessage });

			await vi.waitFor(
				() => {
					expect(logs.warning).toHaveBeenCalledWith(
						"crdt sync rejected",
						expect.objectContaining({
							agentId: MAIN_AGENT_ID,
							error: expect.stringMatching(/read-only/),
						}),
					);
				},
				{ timeout: 2000 },
			);
		} finally {
			client?.close();
			await hub.stop().catch(() => {});
		}
	});

	it("continues CRDT fanout optimistically without waiting for peer delivery ack", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-crdt-ack-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		let client: ClientSocket | undefined;
		try {
			await hub.initializeAgentAdapter();
			const address = await hub.start({ host: "127.0.0.1", port: 0 });
			client = await connectClient(`http://127.0.0.1:${address.port}`);
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			client.on("session:crdt_sync", (payload: SessionCrdtSyncPayload) => {
				syncPayloads.push(payload);
			});
			await peerHello(client, { peerId: "crdt-ack-only" });
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			syncPayloads.length = 0;

			socketServer(hub).broadcastLiveEvent(MAIN_AGENT_ID, {
				type: "status",
				message: Array.from({ length: 20_000 }, (_, index) => `large-${index}`).join("\n"),
			});
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
			syncPayloads.length = 0;
			await new Promise((resolve) => setTimeout(resolve, 50));

			socketServer(hub).broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: "after-large-ack" });
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
		} finally {
			client?.close();
			await hub.stop().catch(() => {});
		}
	});

	it("sends a fresh CRDT sync when the peer requests resync", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-bind-crdt-resync-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		let client: ClientSocket | undefined;
		try {
			await hub.initializeAgentAdapter();
			const address = await hub.start({ host: "127.0.0.1", port: 0 });
			client = await connectClient(`http://127.0.0.1:${address.port}`);
			const syncPayloads: SessionCrdtSyncPayload[] = [];
			installCrdtSyncEcho(client, syncPayloads);
			await peerHello(client, { peerId: "crdt-resync" });
			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			syncPayloads.length = 0;

			client.emit("session:crdt_resync_request");

			await vi.waitFor(
				() => {
					expect(syncPayloads.length).toBeGreaterThan(0);
				},
				{ timeout: 2000 },
			);
		} finally {
			client?.close();
			await hub.stop().catch(() => {});
		}
	});

	it("child socket routes queue_write, queue_flush, abort, set_thinking_level, and invoke_command to the child adapter", async () => {
		const { workspaceDir } = setupHubWithChild("child-routes", "sess-routes");
		const mainQueueWrite = vi.fn().mockResolvedValue(undefined);
		const childQueueWrite = vi.fn().mockResolvedValue(undefined);
		const childQueueFlush = vi.fn().mockResolvedValue({ flushed: true, messages: 1 });
		const mainAbort = vi.fn().mockResolvedValue(undefined);
		const childAbort = vi.fn().mockResolvedValue(undefined);
		const childSetTh = vi.fn();
		const childDequeue = vi.fn().mockResolvedValue([]);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			n += 1;
			if (n === 1) {
				return {
					subscribeLiveEvents: () => () => {},
					enqueueFromPeer: mainQueueWrite,
					abort: mainAbort,
					setThinkingLevel: () => {},
					dequeue: () => {},
					services: { modelRegistry: { find: () => undefined } },
					dispose: () => {},
				} as unknown as HubAgentAdapter;
			}
			return {
				subscribeLiveEvents: () => () => {},
				enqueueFromPeer: childQueueWrite,
				flushInputQueue: childQueueFlush,
				abort: childAbort,
				setThinkingLevel: childSetTh,
				dequeue: childDequeue,
				services: { modelRegistry: { find: () => undefined } },
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const ack0 = await peerHello(client, { peerId: "r-child", agentId: "child-routes" });
		expect(ack0.ok).toBe(true);

		const a1 = await new Promise<{ ok: boolean }>((resolve) =>
			client.emit("session:queue_write", { text: "queued" }, resolve),
		);
		const a2 = await new Promise<{ ok: boolean }>((resolve) => client.emit("session:queue_flush", {}, resolve));
		const a3 = await new Promise<{ ok: boolean }>((resolve) => client.emit("session:abort", {}, resolve));
		const a4 = await new Promise<{ ok: boolean }>((resolve) =>
			client.emit("session:set_thinking_level", { level: "off" }, resolve),
		);
		const a5 = await new Promise<{ ok: boolean }>((resolve) =>
			client.emit("session:invoke_command", { commandName: "dequeue" }, resolve),
		);
		for (const a of [a1, a2, a3, a4, a5]) {
			expect(a.ok).toBe(true);
		}
		expect(mainQueueWrite).not.toHaveBeenCalled();
		expect(childQueueWrite).toHaveBeenCalledWith(
			"r-child",
			"queued",
			expect.objectContaining({
				sentAt: expect.any(String),
			}),
		);
		expect(childQueueFlush).toHaveBeenCalledOnce();
		expect(mainAbort).not.toHaveBeenCalled();
		expect(childAbort).toHaveBeenCalledOnce();
		expect(childSetTh).toHaveBeenCalledWith("off");
		expect(childDequeue).toHaveBeenCalledOnce();
		client.close();
		await hub.stop();
	});

	it("acks session:abort before the adapter fully finishes aborting", async () => {
		const { workspaceDir } = setupHubWithChild("child-fast-abort", "sess-fast-abort");
		const abortDone = createDeferred();
		const childAbort = vi.fn(() => abortDone.promise);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			n += 1;
			return {
				subscribeLiveEvents: () => () => {},
				abort: n === 1 ? vi.fn().mockResolvedValue(undefined) : childAbort,
				services: { modelRegistry: { find: () => undefined } },
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const ack0 = await peerHello(client, { peerId: "fast-abort-child", agentId: "child-fast-abort" });
		expect(ack0.ok).toBe(true);

		let abortAck: { ok: boolean } | undefined;
		const abortAckPromise = new Promise<{ ok: boolean }>((resolve) => {
			client.emit("session:abort", {}, (ack: { ok: boolean }) => {
				abortAck = ack;
				resolve(ack);
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(childAbort).toHaveBeenCalledOnce();
		expect(abortAck).toEqual({ ok: true });

		abortDone.resolve();
		await abortAckPromise;
		client.close();
		await hub.stop();
	});

	it("routes peer-local source messages to the bound adapter with a peer-prefixed source name", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-peer-source-message-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		const enqueueFromSource = vi.fn().mockResolvedValue(undefined);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
			enqueueFromSource,
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const helloAck = await peerHello(client, { peerId: "peer a" });
		expect(helloAck.ok).toBe(true);

		const sourceAck = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			client.emit("source:message", { sourceName: "local source", text: "from peer source" }, resolve);
		});

		expect(sourceAck).toEqual({ ok: true });
		expect(enqueueFromSource).toHaveBeenCalledWith("local source", "from peer source");
		client.close();
		await hub.stop();
	});

	it("fans out peer-local source messages from main to child agents that extend that host source", async () => {
		const { workspaceDir } = setupHubWithChild("child-source", "sess-source");
		mkdirSync(join(workspaceDir, CHILD_AGENT_DIR_NAME, "child-source"), { recursive: true });
		writeJson(join(workspaceDir, CHILD_AGENT_DIR_NAME, "child-source", "sources.json"), {
			extends: { host: { sources: ["local source"] } },
			sources: [],
		});
		const mainEnqueueFromSource = vi.fn().mockResolvedValue(undefined);
		const childEnqueueFromSource = vi.fn().mockResolvedValue(undefined);
		let created = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			created += 1;
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
				enqueueFromSource: created === 1 ? mainEnqueueFromSource : childEnqueueFromSource,
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const helloAck = await peerHello(client, { peerId: "peer a" });
		expect(helloAck.ok).toBe(true);

		const sourceAck = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			client.emit("source:message", { sourceName: "local source", text: "from peer source" }, resolve);
		});

		expect(sourceAck).toEqual({ ok: true });
		expect(mainEnqueueFromSource).toHaveBeenCalledWith("local source", "from peer source");
		expect(childEnqueueFromSource).toHaveBeenCalledWith("local source", "from peer source");
		client.close();
		await hub.stop();
	});

	it("does not partially deliver peer-local source fanout when an extended child is stopped", async () => {
		const { workspaceDir } = setupHubWithChild("child-source-stopped", "sess-source-stopped");
		mkdirSync(join(workspaceDir, CHILD_AGENT_DIR_NAME, "child-source-stopped"), { recursive: true });
		writeJson(join(workspaceDir, CHILD_AGENT_DIR_NAME, "child-source-stopped", "sources.json"), {
			extends: { host: { sources: ["local source"] } },
			sources: [],
		});
		const mainEnqueueFromSource = vi.fn().mockResolvedValue(undefined);
		const childEnqueueFromSource = vi.fn().mockResolvedValue(undefined);
		let created = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			created += 1;
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
				enqueueFromSource: created === 1 ? mainEnqueueFromSource : childEnqueueFromSource,
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		await hub.ensureAgentStarted("child-source-stopped");
		await hub.stopChildAgent(MAIN_AGENT_ID, { agentId: "child-source-stopped" });
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const helloAck = await peerHello(client, { peerId: "peer a" });
		expect(helloAck.ok).toBe(true);

		const sourceAck = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			client.emit("source:message", { sourceName: "local source", text: "from peer source" }, resolve);
		});

		expect(sourceAck.ok).toBe(false);
		expect(sourceAck.error).toMatch(/not initialized|child-source-stopped/);
		expect(mainEnqueueFromSource).not.toHaveBeenCalled();
		expect(childEnqueueFromSource).not.toHaveBeenCalled();
		expect(created).toBe(2);
		client.close();
		await hub.stop();
	});

	it("child socket routes set_model to the child adapter (stub model registry and methods)", async () => {
		const { workspaceDir } = setupHubWithChild("child-sm", "sess-sm");
		const mainSetModel = vi.fn().mockResolvedValue(undefined);
		const childSetModel = vi.fn().mockResolvedValue(undefined);
		const firstStubModel = { resourceId: "model-1", id: "m0" } as unknown as Model<Api>;
		const stubModel = { resourceId: "model-1", id: "m1" } as unknown as Model<Api>;
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			n += 1;
			if (n === 1) {
				return {
					subscribeLiveEvents: () => () => {},
					setModel: mainSetModel,
					services: { modelRegistry: { getAll: () => [] } },
					dispose: () => {},
				} as unknown as HubAgentAdapter;
			}
			return {
				subscribeLiveEvents: () => () => {},
				setModel: childSetModel,
				services: {
					modelRegistry: {
						getAll: () => [firstStubModel, stubModel],
					},
				},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		const h = await peerHello(client, { peerId: "sm-child", agentId: "child-sm" });
		expect(h.ok).toBe(true);
		const setAck = await new Promise<{ ok: boolean }>((resolve) =>
			client.emit("session:set_model", { modelResourceId: "model-1" }, resolve),
		);
		expect(setAck).toEqual({ ok: true });
		expect(mainSetModel).not.toHaveBeenCalled();
		expect(childSetModel).toHaveBeenCalledWith(stubModel);
		client.close();
		await hub.stop();
	});

	it("REST image resources are served outside socket peer delivery state", async () => {
		const { workspaceDir } = setupHubWithChild("child-ig", "sess-ig");
		const imageData = Buffer.from("main live image").toString("base64");
		const id = imageIdForPngData(imageData);
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;
		const m = await connectClient(base);
		const c = await connectClient(base);
		await peerHello(m, { peerId: "img-main" });
		await peerHello(c, { peerId: "img-child", agentId: "child-ig" });
		socketServer(hub).broadcastLiveEvent(MAIN_AGENT_ID, {
			type: "tool_execution_end",
			toolCallId: "read:1",
			toolName: "read",
			result: largeImageForLive(imageData),
			isError: false,
		});
		const response = await fetch(`${base}/resources/images/${id}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(imageData);
		m.close();
		c.close();
		await hub.stop();
	});
});
