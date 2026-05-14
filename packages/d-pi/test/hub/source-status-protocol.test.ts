import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import type { SourceRuntimeStatus } from "../../src/hub/sources/source-types.js";
import { HUB_PROTOCOL_VERSION, type SessionGetSourcesAck } from "../../src/hub/transport/protocol.js";
import {
	createMainOnlySocketHubServer,
	type HubAgentSocketBinding,
	SocketHubServer,
} from "../../src/hub/transport/socket-hub-server.js";

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

describe("session:get_sources protocol", () => {
	it("returns structured source statuses for a registered peer", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const sampleSources: SourceRuntimeStatus[] = [
			{ name: "src-a", transport: "stdio", agentId: "root", origin: "hub", status: "running" },
			{
				name: "src-b",
				transport: "stdio",
				agentId: "child-a",
				origin: "hub",
				status: "error",
				error: "spawn failed",
			},
		];
		const getSourceStatuses = vi.fn((): SourceRuntimeStatus[] => sampleSources);
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			getSourceStatuses,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client: ClientSocket = ioClient(`http://127.0.0.1:${address.port}`, {
			transports: ["websocket"],
			autoConnect: true,
		});

		await new Promise<void>((resolve, reject) => {
			client.on("connect", () => resolve());
			client.on("connect_error", (err) => reject(err));
		});

		const peerId = "peer-source-status";
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

		const ack = await new Promise<SessionGetSourcesAck>((resolve) => {
			client.emit("session:get_sources", {}, (response: SessionGetSourcesAck) => resolve(response));
		});

		expect(ack.ok).toBe(true);
		if (!ack.ok) {
			throw new Error("expected ok ack");
		}
		expect(ack.sources).toEqual(sampleSources);
		expect(getSourceStatuses).toHaveBeenCalledTimes(1);

		client.close();
		await server.stop();
	});

	it("returns only statuses that feed the peer's bound agent", async () => {
		const mainRegistry = new PeerRegistry();
		const childRegistry = new PeerRegistry();
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const bindings: Record<string, HubAgentSocketBinding> = {
			root: {
				sessionService: createStubSessionService(),
				peerRegistry: mainRegistry,
				tools: [],
				agentAdapter: mockAdapter,
			},
			"child-a": {
				sessionService: createStubSessionService(),
				peerRegistry: childRegistry,
				tools: [],
				agentAdapter: mockAdapter,
			},
		};
		const sampleSources: SourceRuntimeStatus[] = [
			{
				resourceId: "src-main",
				name: "shared",
				transport: "stdio",
				agentId: "root",
				origin: "hub",
				status: "running",
			},
			{
				resourceId: "child-a:src-main",
				name: "shared",
				transport: "stdio",
				agentId: "child-a",
				origin: "hub",
				status: "running",
			},
		];
		const server = new SocketHubServer({
			getDefaultAgentId: () => "root",
			getAgentIds: () => Object.keys(bindings),
			getAgentRuntime: (agentId) => bindings[agentId],
			authenticateToken: () => ({
				id: "test-root",
				name: "root",
				description: "test",
				user: "test-user",
				purpose: "test access",
				scopeRootAgentId: "root",
				createdByAgentId: "root",
				root: true,
			}),
			isAgentInScope: (identity, targetAgentId) =>
				identity.scopeRootAgentId === "root" && (targetAgentId === "root" || targetAgentId === "child-a"),
			getHttpSessionService: () => bindings.root!.sessionService,
			subscribeAllAgentSessionEvents: () => () => {},
			getSourceStatuses: (agentId) => sampleSources.filter((source) => source.agentId === agentId),
			sourceMutators: {
				pause: async () => undefined,
				restart: async () => undefined,
				remove: async () => undefined,
			},
			getMcpServerStatuses: () => [],
			getMcpConfigError: () => undefined,
			mcpMutators: {
				pauseServer: async () => ({ ok: true, servers: [] }),
				restartServer: async () => ({ ok: true, servers: [] }),
				removeServer: async () => ({ ok: true, servers: [] }),
			},
		});
		server.initializeViewDocumentsForAgents(["root", "child-a"]);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client: ClientSocket = ioClient(`http://127.0.0.1:${address.port}`, {
			transports: ["websocket"],
			autoConnect: true,
		});
		await new Promise<void>((resolve, reject) => {
			client.on("connect", () => resolve());
			client.on("connect_error", (err) => reject(err));
		});
		await new Promise<void>((resolve, reject) => {
			client.emit(
				"peer:hello",
				{ peerId: "peer-child", agentId: "child-a", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION },
				(ack: { ok: boolean; error?: string }) => {
					if (ack.ok) {
						resolve();
						return;
					}
					reject(new Error(ack.error ?? "peer:hello failed"));
				},
			);
		});

		const ack = await new Promise<SessionGetSourcesAck>((resolve) => {
			client.emit("session:get_sources", {}, (response: SessionGetSourcesAck) => resolve(response));
		});

		expect(ack).toEqual({ ok: true, sources: [sampleSources[1]] });

		client.close();
		await server.stop();
	});

	it("rejects session:get_sources when the socket is not registered", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client: ClientSocket = ioClient(`http://127.0.0.1:${address.port}`, {
			transports: ["websocket"],
			autoConnect: true,
		});

		await new Promise<void>((resolve, reject) => {
			client.on("connect", () => resolve());
			client.on("connect_error", (err) => reject(err));
		});

		const ack = await new Promise<SessionGetSourcesAck>((resolve) => {
			client.emit("session:get_sources", {}, (response: SessionGetSourcesAck) => resolve(response));
		});

		expect(ack.ok).toBe(false);
		if (ack.ok) {
			throw new Error("expected failed ack");
		}
		expect(ack.error).toMatch(/not registered/i);

		client.close();
		await server.stop();
	});
});
