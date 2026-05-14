import { describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import { SocketHubServer, shouldCompressCrdtPayload } from "../../src/hub/transport/socket-hub-server.js";

type FanoutStats = {
	eventCount: number;
	payloadTotalBytes: number;
	payloadMaxBytes: number;
};

type SocketHubServerInternals = {
	io: { sockets: { sockets: Map<string, unknown> } } | undefined;
	socketAgentIds: Map<string, string>;
	viewDocuments: Map<string, { getSnapshot(): { agentsById: Record<string, { status: { isRunning: boolean } }> } }>;
	emitPendingCrdtSyncToSocket(agentId: string, socket: unknown): FanoutStats;
	emitSessionEventForAgent(
		agentId: string,
		event:
			| { type: "queue_changed"; seq: number; timestamp: string; messages: [] }
			| { type: "run_state_changed"; seq: number; timestamp: string; isRunning: boolean },
	): void;
};

function createSnapshot(id: string, isRunning: boolean): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id,
			timestamp: "2026-05-12T00:00:00.000Z",
			cwd: "/tmp/pi",
			version: 3,
		},
		sessionFile: `/tmp/pi/.pi-hub/${id}.jsonl`,
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

describe("SocketHubServer fanout", () => {
	it("coalesces bursty live CRDT fanout into one short-window flush", () => {
		vi.useFakeTimers();
		try {
			const server = new SocketHubServer({
				getDefaultAgentId: () => MAIN_AGENT_ID,
				getAgentIds: () => [MAIN_AGENT_ID],
				getAgentRuntime: () => undefined,
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
				getHttpSessionService: () => {
					throw new Error("not used");
				},
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
					pauseServer: async () => ({ ok: false, error: "not used" }),
					restartServer: async () => ({ ok: false, error: "not used" }),
					removeServer: async () => ({ ok: false, error: "not used" }),
				},
			});
			const internals = server as unknown as SocketHubServerInternals;
			const socket = { id: "socket-a", connected: true };
			internals.io = { sockets: { sockets: new Map([["socket-a", socket]]) } };
			internals.socketAgentIds.set("socket-a", MAIN_AGENT_ID);
			const fanoutSpy = vi
				.spyOn(internals, "emitPendingCrdtSyncToSocket")
				.mockReturnValue({ eventCount: 1, payloadTotalBytes: 8, payloadMaxBytes: 8 });

			server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: "one" });
			server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: "two" });
			server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: "three" });

			expect(fanoutSpy).not.toHaveBeenCalled();
			vi.advanceTimersByTime(32);
			expect(fanoutSpy).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(fanoutSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes high-priority session fanout immediately over pending live fanout", () => {
		vi.useFakeTimers();
		try {
			const server = new SocketHubServer({
				getDefaultAgentId: () => MAIN_AGENT_ID,
				getAgentIds: () => [MAIN_AGENT_ID],
				getAgentRuntime: () =>
					({
						sessionService: {},
						peerRegistry: {},
						tools: [],
						agentAdapter: undefined,
					}) as never,
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
				getHttpSessionService: () => {
					throw new Error("not used");
				},
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
					pauseServer: async () => ({ ok: false, error: "not used" }),
					restartServer: async () => ({ ok: false, error: "not used" }),
					removeServer: async () => ({ ok: false, error: "not used" }),
				},
			});
			const internals = server as unknown as SocketHubServerInternals;
			const socket = { id: "socket-a", connected: true };
			internals.io = { sockets: { sockets: new Map([["socket-a", socket]]) } };
			internals.socketAgentIds.set("socket-a", MAIN_AGENT_ID);
			const fanoutSpy = vi
				.spyOn(internals, "emitPendingCrdtSyncToSocket")
				.mockReturnValue({ eventCount: 1, payloadTotalBytes: 8, payloadMaxBytes: 8 });

			server.broadcastLiveEvent(MAIN_AGENT_ID, { type: "status", message: "one" });
			expect(fanoutSpy).not.toHaveBeenCalled();

			internals.emitSessionEventForAgent(MAIN_AGENT_ID, {
				type: "queue_changed",
				seq: 1,
				timestamp: new Date().toISOString(),
				messages: [],
			});

			expect(fanoutSpy).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(33);
			expect(fanoutSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fans child agent run-state changes out to root agent list views", () => {
		const childAgentId = "child-a";
		const snapshots = new Map([
			[MAIN_AGENT_ID, createSnapshot("root-session", false)],
			[childAgentId, createSnapshot("child-session", false)],
		]);
		const server = new SocketHubServer({
			getDefaultAgentId: () => MAIN_AGENT_ID,
			getAgentIds: () => [MAIN_AGENT_ID, childAgentId],
			getAgentRuntime: (agentId) =>
				({
					sessionService: {
						getSnapshot: () => snapshots.get(agentId)!,
					} as HubSessionService,
					peerRegistry: {},
					tools: [],
					agentAdapter: undefined,
				}) as never,
			getAgentMetadata: (agentId) => ({
				kind: agentId === MAIN_AGENT_ID ? "root" : "child",
				...(agentId === childAgentId ? { parentId: MAIN_AGENT_ID, name: "Child A" } : {}),
			}),
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
				identity.scopeRootAgentId === MAIN_AGENT_ID &&
				(targetAgentId === MAIN_AGENT_ID || targetAgentId === childAgentId),
			getHttpSessionService: () => {
				throw new Error("not used");
			},
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
				pauseServer: async () => ({ ok: false, error: "not used" }),
				restartServer: async () => ({ ok: false, error: "not used" }),
				removeServer: async () => ({ ok: false, error: "not used" }),
			},
		});
		server.initializeViewDocumentsForAgents([MAIN_AGENT_ID, childAgentId]);
		const internals = server as unknown as SocketHubServerInternals;
		const socket = { id: "socket-root", connected: true };
		internals.io = { sockets: { sockets: new Map([["socket-root", socket]]) } };
		internals.socketAgentIds.set("socket-root", MAIN_AGENT_ID);
		const fanoutSpy = vi
			.spyOn(internals, "emitPendingCrdtSyncToSocket")
			.mockReturnValue({ eventCount: 1, payloadTotalBytes: 8, payloadMaxBytes: 8 });

		internals.emitSessionEventForAgent(childAgentId, {
			type: "run_state_changed",
			seq: 1,
			timestamp: new Date().toISOString(),
			isRunning: true,
		});

		expect(internals.viewDocuments.get(MAIN_AGENT_ID)?.getSnapshot().agentsById[childAgentId]?.status.isRunning).toBe(
			true,
		);
		expect(fanoutSpy).toHaveBeenCalledTimes(1);
	});

	it("compresses only large CRDT payloads", () => {
		expect(shouldCompressCrdtPayload(32 * 1024 - 1)).toBe(false);
		expect(shouldCompressCrdtPayload(32 * 1024)).toBe(true);
	});
});
