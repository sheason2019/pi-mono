import { describe, expect, it } from "vitest";
import { HubViewDocument } from "../src/d-pi-hub.js";
import { HUB_PROTOCOL_VERSION } from "../src/d-pi-hub-protocol.js";
import {
	DPiWebClient,
	type DPiWebSocketLike,
	resolveAgentIdFromPath,
	resolveDefaultAgentIdFromWelcome,
} from "../src/remote-client.js";

type Listener = (payload?: unknown) => void;
type EmitRecord = { event: string; payload: unknown };

class FakeSocket implements DPiWebSocketLike {
	readonly emitted: EmitRecord[] = [];
	private readonly listeners = new Map<string, Listener[]>();

	on(event: string, listener: Listener): DPiWebSocketLike {
		const listeners = this.listeners.get(event) ?? [];
		listeners.push(listener);
		this.listeners.set(event, listeners);
		return this;
	}

	emit(
		event: string,
		payload: unknown,
		ack?: (response: { ok: true } | { ok: false; error: string }) => void,
	): DPiWebSocketLike {
		this.emitted.push({ event, payload });
		ack?.({ ok: true } as const);
		return this;
	}

	disconnect(): void {
		this.trigger("disconnect", "client disconnect");
	}

	trigger(event: string, payload?: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}

describe("DPiWebClient", () => {
	it("resolves agent ids from Web UI paths", () => {
		expect(resolveAgentIdFromPath("/")).toBe("root");
		expect(resolveAgentIdFromPath("/agents/main")).toBe("root");
		expect(resolveAgentIdFromPath("/agents/child-a")).toBe("child-a");
		expect(resolveAgentIdFromPath("/agents/child%20space")).toBe("child space");
		expect(resolveAgentIdFromPath("/assets/index.js")).toBe("root");
	});

	it("connects as an unbound host UI with an explicit token", async () => {
		const socket = new FakeSocket();
		const client = new DPiWebClient({
			url: "http://hub.test",
			peerId: "web-test",
			token: "dpi_test",
			socketFactory: () => socket,
		});

		const connecting = client.connect();
		socket.trigger("connect");
		await connecting;

		expect(socket.emitted[0]).toEqual({
			event: "peer:hello",
			payload: expect.objectContaining({
				displayName: "Web UI",
				peerId: "web-test",
				token: "dpi_test",
				clientKind: "host",
				protocolVersion: HUB_PROTOCOL_VERSION,
				platform: "web",
				tools: [],
			}),
		});
		expect(socket.emitted[0]?.payload).not.toHaveProperty("agentId");
		expect(client.snapshot.connectionState).toBe("connected");
	});

	it("connects as a child host UI when an agent id is provided", async () => {
		const socket = new FakeSocket();
		const client = new DPiWebClient({
			agentId: "child-a",
			peerId: "web-test",
			token: "dpi_test",
			socketFactory: () => socket,
		});

		const connecting = client.connect();
		socket.trigger("connect");
		await connecting;

		expect(socket.emitted[0]).toEqual({
			event: "peer:hello",
			payload: expect.objectContaining({
				agentId: "child-a",
				clientKind: "host",
				peerId: "web-test",
			}),
		});
	});

	it("keeps the requested agent selected even if welcome reports another agent", async () => {
		const socket = new FakeSocket();
		const client = new DPiWebClient({
			agentId: "child-a",
			peerId: "web-test",
			token: "dpi_test",
			socketFactory: () => socket,
		});
		const connecting = client.connect();
		socket.trigger("connect");
		await connecting;
		socket.trigger("hub:welcome", {
			sessionId: "main-session",
			peerId: "web-test",
			agentId: "root",
			clientKind: "host",
			hubVersion: "0.69.0",
			protocolVersion: HUB_PROTOCOL_VERSION,
			toolNames: [],
		});
		const hub = new HubViewDocument();
		hub.syncAgentList(["root", "child-a"]);
		const outgoing = hub.generateSyncMessage(hub.createSyncState());
		expect(outgoing.message).toBeDefined();

		socket.trigger("session:crdt_sync", { message: outgoing.message, format: outgoing.format });

		expect(client.snapshot.agentId).toBe("child-a");
		expect(client.snapshot.agent?.agentId).toBe("child-a");
	});

	it("queues and flushes submitted text", async () => {
		const socket = new FakeSocket();
		const client = new DPiWebClient({
			peerId: "web-test",
			token: "dpi_test",
			socketFactory: () => socket,
		});
		const connecting = client.connect();
		socket.trigger("connect");
		await connecting;

		await client.sendMessage(" hello hub ");

		expect(socket.emitted.slice(1)).toEqual([
			{ event: "session:queue_write", payload: { text: "hello hub" } },
			{ event: "session:queue_flush", payload: {} },
		]);
	});

	it("applies hub CRDT sync without sending an optimistic acknowledgement", async () => {
		const socket = new FakeSocket();
		const client = new DPiWebClient({
			peerId: "web-test",
			token: "dpi_test",
			socketFactory: () => socket,
		});
		const connecting = client.connect();
		socket.trigger("connect");
		await connecting;
		const hub = new HubViewDocument();
		hub.syncAgentList(["root"]);
		const outgoing = hub.generateSyncMessage(hub.createSyncState());
		expect(outgoing.message).toBeDefined();
		socket.emitted.length = 0;

		socket.trigger("session:crdt_sync", { message: outgoing.message, format: outgoing.format });

		expect(socket.emitted).toEqual([]);
		expect(client.snapshot.view.agentOrder).toEqual(["root"]);
	});

	it("requests a CRDT resync when applying a hub sync message fails", async () => {
		const socket = new FakeSocket();
		const client = new DPiWebClient({
			peerId: "web-test",
			token: "dpi_test",
			socketFactory: () => socket,
		});
		const connecting = client.connect();
		socket.trigger("connect");
		await connecting;
		socket.emitted.length = 0;

		socket.trigger("session:crdt_sync", { message: new Uint8Array([1, 2, 3, 4]) });

		expect(socket.emitted).toEqual([{ event: "session:crdt_resync_request", payload: undefined }]);
	});

	it("resolves the post-auth default agent from token identity metadata", () => {
		expect(
			resolveDefaultAgentIdFromWelcome({
				sessionId: "s",
				peerId: "p",
				agentId: "root",
				clientKind: "host",
				hubVersion: "0",
				protocolVersion: HUB_PROTOCOL_VERSION,
				toolNames: [],
				identity: {
					id: "token-a",
					name: "child token",
					description: "child access",
					user: "test-user",
					purpose: "test access",
					scopeRootAgentId: "child-a",
					createdByAgentId: "child-a",
					root: false,
				},
				scopeRootAgentId: "child-a",
			}),
		).toBe("child-a");
	});
});
