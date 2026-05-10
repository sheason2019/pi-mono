import { describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { RegisteredPeer } from "../../src/hub/peers/peer-types.js";
import { PeerToolBridge } from "../../src/hub/tools/peer-tool-bridge.js";
import {
	HUB_PROTOCOL_VERSION,
	type ToolCallAckPayload,
	type ToolCallErrorPayload,
	type ToolCallRequestPayload,
	type ToolCallResultPayload,
	type ToolCallUpdatePayload,
} from "../../src/hub/transport/protocol.js";
import type { SocketHubServer } from "../../src/hub/transport/socket-hub-server.js";

/**
 * Transport stub that only implements what `PeerToolBridge` needs, with manual fan-out
 * to simulate a shared `SocketHubServer` receiving events from the wrong `RegisteredPeer.agentId`.
 */
class FakeToolTransport {
	private ackListeners = new Set<(e: { peer: RegisteredPeer; payload: ToolCallAckPayload }) => void>();
	private updateListeners = new Set<(e: { peer: RegisteredPeer; payload: ToolCallUpdatePayload }) => void>();
	private resultListeners = new Set<(e: { peer: RegisteredPeer; payload: ToolCallResultPayload }) => void>();
	private errorListeners = new Set<(e: { peer: RegisteredPeer; payload: ToolCallErrorPayload }) => void>();
	sendToolCallRequest: (agentId: string, _peerId: string, _payload: ToolCallRequestPayload) => void = vi.fn();
	onToolCallAck = (listener: (e: { peer: RegisteredPeer; payload: ToolCallAckPayload }) => void) => {
		this.ackListeners.add(listener);
		return () => {
			this.ackListeners.delete(listener);
		};
	};
	onToolCallUpdate = (listener: (e: { peer: RegisteredPeer; payload: ToolCallUpdatePayload }) => void) => {
		this.updateListeners.add(listener);
		return () => {
			this.updateListeners.delete(listener);
		};
	};
	onToolCallResult = (listener: (e: { peer: RegisteredPeer; payload: ToolCallResultPayload }) => void) => {
		this.resultListeners.add(listener);
		return () => {
			this.resultListeners.delete(listener);
		};
	};
	onToolCallError = (listener: (e: { peer: RegisteredPeer; payload: ToolCallErrorPayload }) => void) => {
		this.errorListeners.add(listener);
		return () => {
			this.errorListeners.delete(listener);
		};
	};

	emitResult(peer: RegisteredPeer, payload: ToolCallResultPayload) {
		for (const l of this.resultListeners) {
			l({ peer, payload });
		}
	}

	emitError(peer: RegisteredPeer, payload: ToolCallErrorPayload) {
		for (const l of this.errorListeners) {
			l({ peer, payload });
		}
	}

	emitAck(peer: RegisteredPeer, payload: ToolCallAckPayload) {
		for (const l of this.ackListeners) {
			l({ peer, payload });
		}
	}

	emitUpdate(peer: RegisteredPeer, payload: ToolCallUpdatePayload) {
		for (const l of this.updateListeners) {
			l({ peer, payload });
		}
	}
}

function makePeer(overrides: Partial<RegisteredPeer> & { peerId: string; agentId: string }): RegisteredPeer {
	return {
		socketId: "sock-1",
		protocolVersion: HUB_PROTOCOL_VERSION,
		executorEnabled: true,
		tools: ["read"],
		connectedAt: "2020-01-01T00:00:00.000Z",
		transport: "socket.io",
		...overrides,
	};
}

function registerPeerWithReadTool(reg: PeerRegistry, socketId: string, peerId: string, agentId: string): void {
	reg.register(
		socketId,
		{
			peerId,
			token: "test-token",
			protocolVersion: HUB_PROTOCOL_VERSION,
		},
		agentId,
	);
	reg.updateConfigBySocketId(socketId, { tools: ["read"] });
}

describe("PeerToolBridge agent scoping on inbound transport", () => {
	it("ignores tool call result when RegisteredPeer.agentId does not match the bridge agentId", async () => {
		const t = new FakeToolTransport();
		const reg = new PeerRegistry();
		const pMain = makePeer({ peerId: "p1", agentId: MAIN_AGENT_ID });
		registerPeerWithReadTool(reg, "sock", pMain.peerId, MAIN_AGENT_ID);
		const bridge = new PeerToolBridge(MAIN_AGENT_ID, reg, t as unknown as SocketHubServer);
		const p = bridge.executeTool({
			toolCallId: "tc-1",
			toolName: "read",
			peerId: "p1",
			args: {},
		});
		t.emitResult(makePeer({ peerId: "p1", agentId: "other-child" }), {
			toolCallId: "tc-1",
			result: { content: [], details: undefined },
		});
		t.emitResult(makePeer({ peerId: "p1", agentId: MAIN_AGENT_ID }), {
			toolCallId: "tc-1",
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
		});
		const out = await p;
		expect((out.content[0] as { text: string }).text).toBe("ok");
		bridge.dispose();
	});

	it("ignores tool call error for mismatched agentId", async () => {
		const t = new FakeToolTransport();
		const reg = new PeerRegistry();
		registerPeerWithReadTool(reg, "sock", "p2", MAIN_AGENT_ID);
		const bridge = new PeerToolBridge(MAIN_AGENT_ID, reg, t as unknown as SocketHubServer);
		const p = bridge
			.executeTool({
				toolCallId: "tc-2",
				toolName: "read",
				peerId: "p2",
				args: {},
			})
			.catch((e) => e as Error);
		t.emitError(makePeer({ peerId: "p2", agentId: "other" }), {
			toolCallId: "tc-2",
			message: "should ignore",
		});
		t.emitError(makePeer({ peerId: "p2", agentId: MAIN_AGENT_ID }), { toolCallId: "tc-2", message: "real" });
		const err = await p;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("real");
		bridge.dispose();
	});

	it("ignores tool call ack when RegisteredPeer.agentId does not match the bridge agentId", async () => {
		const t = new FakeToolTransport();
		const reg = new PeerRegistry();
		registerPeerWithReadTool(reg, "sock", "p-ack", MAIN_AGENT_ID);
		const bridge = new PeerToolBridge(MAIN_AGENT_ID, reg, t as unknown as SocketHubServer);
		const p = bridge.executeTool({
			toolCallId: "ack-tc",
			toolName: "read",
			peerId: "p-ack",
			args: {},
		});
		t.emitAck(makePeer({ peerId: "p-ack", agentId: "x-other" }), { toolCallId: "ack-tc" });
		t.emitResult(makePeer({ peerId: "p-ack", agentId: MAIN_AGENT_ID }), {
			toolCallId: "ack-tc",
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
		});
		const out = await p;
		expect((out.content[0] as { text: string }).text).toBe("ok");
		bridge.dispose();
	});

	it("ignores tool call update when RegisteredPeer.agentId does not match the bridge agentId", async () => {
		const t = new FakeToolTransport();
		const reg = new PeerRegistry();
		registerPeerWithReadTool(reg, "sock", "p-upd", MAIN_AGENT_ID);
		const bridge = new PeerToolBridge(MAIN_AGENT_ID, reg, t as unknown as SocketHubServer);
		const onUpdate = vi.fn();
		const p = bridge.executeTool({
			toolCallId: "upd-tc",
			toolName: "read",
			peerId: "p-upd",
			args: {},
			onUpdate,
		});
		t.emitUpdate(makePeer({ peerId: "p-upd", agentId: "other" }), {
			toolCallId: "upd-tc",
			partialResult: { content: [{ type: "text", text: "bad" }], details: undefined },
		});
		t.emitUpdate(makePeer({ peerId: "p-upd", agentId: MAIN_AGENT_ID }), {
			toolCallId: "upd-tc",
			partialResult: { content: [{ type: "text", text: "partial" }], details: undefined },
		});
		t.emitResult(makePeer({ peerId: "p-upd", agentId: MAIN_AGENT_ID }), {
			toolCallId: "upd-tc",
			result: { content: [{ type: "text", text: "fin" }], details: undefined },
		});
		await p;
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect((onUpdate.mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }).content[0]?.text).toBe(
			"partial",
		);
		bridge.dispose();
	});

	it("ignores tool call result when peer.agentId does not match a non-main bridge agentId", async () => {
		const childAgentId = "child-iso-bridge";
		const t = new FakeToolTransport();
		const reg = new PeerRegistry();
		registerPeerWithReadTool(reg, "sock", "p-child-scope", childAgentId);
		const bridge = new PeerToolBridge(childAgentId, reg, t as unknown as SocketHubServer);
		const p = bridge.executeTool({
			toolCallId: "tc-child",
			toolName: "read",
			peerId: "p-child-scope",
			args: {},
		});
		t.emitResult(makePeer({ peerId: "p-child-scope", agentId: MAIN_AGENT_ID }), {
			toolCallId: "tc-child",
			result: { content: [{ type: "text", text: "wrong-agent" }], details: undefined },
		});
		t.emitResult(makePeer({ peerId: "p-child-scope", agentId: childAgentId }), {
			toolCallId: "tc-child",
			result: { content: [{ type: "text", text: "ok-child" }], details: undefined },
		});
		const out = await p;
		expect((out.content[0] as { text: string }).text).toBe("ok-child");
		bridge.dispose();
	});

	it("executeTool throws when the registry entry has a different agentId than the bridge (defensive)", async () => {
		const t = new FakeToolTransport();
		const badRegistry: Pick<PeerRegistry, "get" | "subscribe"> = {
			subscribe: () => () => {},
			get: (peerId: string) =>
				peerId === "p-bad" ? makePeer({ peerId: "p-bad", agentId: "registry-wrong", tools: ["read"] }) : undefined,
		};
		const bridge = new PeerToolBridge(
			MAIN_AGENT_ID,
			badRegistry as unknown as PeerRegistry,
			t as unknown as SocketHubServer,
		);
		await expect(
			bridge.executeTool({ toolCallId: "x", toolName: "read", peerId: "p-bad", args: {} }),
		).rejects.toThrow(/not in this agent's scope/);
		bridge.dispose();
	});
});
