import type { UserMessage } from "@sheason/pi-ai";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../coding-agent/src/core/messages.js";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import {
	createAgentMessageSource,
	createHostMessageSource,
	createPeerMessageSource,
} from "../../src/hub/agent/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import { type ActionAck, HUB_PROTOCOL_VERSION } from "../../src/hub/transport/protocol.js";
import { createMainOnlySocketHubServer } from "../../src/hub/transport/socket-hub-server.js";

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
		assertOperationSupported: () => {},
	} as unknown as HubSessionService;
}

describe("peer source metadata at hub boundary", () => {
	it("creates stable peer and agent messageSource metadata", () => {
		expect(createPeerMessageSource("peer-a")).toEqual({ kind: "peer", name: "peer-a" });
		expect(createPeerMessageSource("peer-a", { sentAt: "2026-05-09T11:12:13.000Z" })).toEqual({
			kind: "peer",
			name: "peer-a",
			sentAt: "2026-05-09T11:12:13.000Z",
		});
		expect(
			createPeerMessageSource("peer-a", {
				authTokenName: "web guests",
				authTokenDescription: "Guest access",
				authUser: "Li Xujie",
				authPurpose: "Code review guest access",
			}),
		).toEqual({
			kind: "peer",
			name: "peer-a",
			contextHeaders: [
				{ label: "security note", value: "注意区分消息来源和人员权限范围" },
				{ label: "message source auth token", value: "web guests" },
				{ label: "message source auth token description", value: "Guest access" },
				{ label: "message source user", value: "Li Xujie" },
				{ label: "message source purpose", value: "Code review guest access" },
			],
		});
		expect(createHostMessageSource()).toEqual({ kind: "host", name: "host" });
		expect(createHostMessageSource("web-abc")).toEqual({ kind: "host", name: "web-abc" });
		expect(createAgentMessageSource("child-a")).toEqual({ kind: "agent", name: "child-a" });
	});

	it("keeps d-pi metadata out of persisted core message conversion", () => {
		const user: UserMessage = {
			role: "user",
			content: "hello",
			timestamp: 1,
			messageSource: createPeerMessageSource("peer-a", {
				authTokenName: "web guests",
				authTokenDescription: "Guest access",
				authUser: "Li Xujie",
				authPurpose: "Code review guest access",
			}),
		};

		const out = convertToLlm([user]);
		const first = out[0]!;

		expect(first.role === "user" && typeof first.content === "string" ? first.content : "").toBe("hello");
	});

	it("routes session:queue_write and session:queue_flush for registered peers", async () => {
		const enqueueFromPeer = vi.fn(async (_peerId: string, _text: string, _metadata?: { sentAt?: string }) => {});
		const flushInputQueue = vi.fn(async () => ({ flushed: true, messages: 1 }));
		const mockAdapter = { enqueueFromPeer, flushInputQueue } as unknown as HubAgentAdapter;

		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
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

		const peerId = "peer-socket-test";
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
			client.emit(
				"session:queue_write",
				{ text: "hello-queue", sentAt: "2026-05-09T11:12:13.000Z" },
				(ack: ActionAck) => {
					if (ack.ok) {
						resolve();
						return;
					}
					reject(new Error(ack.error ?? "session:queue_write failed"));
				},
			);
		});

		await new Promise<void>((resolve, reject) => {
			client.emit("session:queue_flush", {}, (ack: ActionAck) => {
				if (ack.ok) {
					resolve();
					return;
				}
				reject(new Error(ack.error ?? "session:queue_flush failed"));
			});
		});

		expect(enqueueFromPeer).toHaveBeenCalledWith(peerId, "hello-queue", {
			sentAt: "2026-05-09T11:12:13.000Z",
			authTokenName: "root",
			authTokenDescription: "Test root identity",
			authUser: "test-root-user",
			authPurpose: "test root access",
		});
		expect(flushInputQueue).toHaveBeenCalledOnce();

		client.close();
		await server.stop();
	});

	it("routes host UI queue writes without registering it as an executor peer", async () => {
		const enqueueFromHost = vi.fn(async (_hostId: string, _text: string, _metadata?: { sentAt?: string }) => {});
		const flushInputQueue = vi.fn(async () => ({ flushed: true, messages: 1 }));
		const mockAdapter = { enqueueFromHost, flushInputQueue } as unknown as HubAgentAdapter;

		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
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

		await new Promise<void>((resolve, reject) => {
			client.emit(
				"peer:hello",
				{
					peerId: "web-ui",
					token: "test-token",
					protocolVersion: HUB_PROTOCOL_VERSION,
					clientKind: "host",
					tools: ["ignored-tool"],
				},
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
			client.emit("session:queue_write", { text: "hello-from-web" }, (ack: ActionAck) => {
				if (ack.ok) {
					resolve();
					return;
				}
				reject(new Error(ack.error ?? "session:queue_write failed"));
			});
		});

		await new Promise<void>((resolve, reject) => {
			client.emit("session:queue_flush", {}, (ack: ActionAck) => {
				if (ack.ok) {
					resolve();
					return;
				}
				reject(new Error(ack.error ?? "session:queue_flush failed"));
			});
		});

		expect(registry.size()).toBe(0);
		expect(registry.list()).toEqual([]);
		expect(enqueueFromHost).toHaveBeenCalledWith("web-ui", "hello-from-web", {
			sentAt: expect.any(String),
			authTokenName: "root",
			authTokenDescription: "Test root identity",
			authUser: "test-root-user",
			authPurpose: "test root access",
		});
		expect(flushInputQueue).toHaveBeenCalledOnce();

		client.close();
		await server.stop();
	});

	it("rejects session:queue_write when socket is not registered as a peer", async () => {
		const enqueueFromPeer = vi.fn();
		const mockAdapter = { enqueueFromPeer } as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
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

		const ack = await new Promise<ActionAck>((resolve) => {
			client.emit("session:queue_write", { text: "nope" }, (response: ActionAck) => resolve(response));
		});

		expect(ack.ok).toBe(false);
		if (ack.ok) {
			throw new Error("expected failed ack");
		}
		expect(ack.error).toMatch(/not registered/i);
		expect(enqueueFromPeer).not.toHaveBeenCalled();

		client.close();
		await server.stop();
	});

	it("rejects session:abort and session:invoke_command for unregistered sockets (shared peer registration guard)", async () => {
		const abort = vi.fn();
		const reload = vi.fn();
		const mockAdapter = { abort, reload } as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
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

		const abortAck = await new Promise<ActionAck>((resolve) => {
			client.emit("session:abort", {}, (response: ActionAck) => resolve(response));
		});
		expect(abortAck.ok).toBe(false);
		if (abortAck.ok) {
			throw new Error("expected failed ack");
		}
		expect(abortAck.error).toMatch(/not registered/i);
		expect(abort).not.toHaveBeenCalled();

		const invokeAck = await new Promise<ActionAck>((resolve) => {
			client.emit("session:invoke_command", { commandName: "reload" }, (response: ActionAck) => resolve(response));
		});
		expect(invokeAck.ok).toBe(false);
		if (invokeAck.ok) {
			throw new Error("expected failed ack");
		}
		expect(invokeAck.error).toMatch(/not registered/i);
		expect(reload).not.toHaveBeenCalled();

		client.close();
		await server.stop();
	});
});
