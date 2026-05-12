import * as Automerge from "@automerge/automerge";
import { describe, expect, it } from "vitest";
import {
	HubViewDocument,
	type HubViewDocumentState,
	type HubViewProjectionState,
	type HubViewSyncMessage,
} from "../../src/hub/session/hub-view-document.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";

function createSnapshot(id: string, isRunning: boolean): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id,
			timestamp: "2026-04-27T00:00:00.000Z",
			cwd: "/tmp/pi",
			version: 3,
		},
		sessionFile: "/tmp/pi/.pi/session.jsonl",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

function createLargeSnapshot(id: string, isRunning: boolean): HubSessionSnapshot {
	const snapshot = createSnapshot(id, isRunning);
	const text = createDeterministicText(1_000_000);
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
	return {
		...snapshot,
		entries: [
			{
				type: "message",
				id: "large-entry",
				parentId: null,
				timestamp: "2026-04-27T00:00:00.000Z",
				message,
			},
		],
		context: { ...snapshot.context, messages: [message] },
	};
}

function createDeterministicText(length: number): string {
	let state = 0x12345678;
	let text = "";
	for (let i = 0; i < length; i += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		text += String.fromCharCode(32 + (state % 95));
	}
	return text;
}

describe("HubViewDocument", () => {
	it("syncs the hub-owned session view to a peer via Automerge messages", () => {
		const hub = new HubViewDocument();
		hub.updateSession(createSnapshot("sess-a", false), "main");

		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();

		[hubSync, peerDoc, peerSync] = exchange(hub, hubSync, peerDoc, peerSync);
		expect(peerDoc.agentsById.main?.sessionId).toBe("sess-a");
		expect(peerDoc.agentsById.main?.status.isRunning).toBe(false);

		hub.updateSession(createSnapshot("sess-a", true), "main");
		[hubSync, peerDoc, peerSync] = exchange(hub, hubSync, peerDoc, peerSync);
		expect(peerDoc.agentsById.main?.status.isRunning).toBe(true);
	});

	it("can reset to the current session state without carrying old live view history", () => {
		const hub = new HubViewDocument();
		hub.updateLiveEvent({ type: "status", message: "stale live status" }, "main");

		hub.resetSession(createSnapshot("sess-reset", false), "main");

		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();
		[hubSync, peerDoc, peerSync] = exchange(hub, hubSync, peerDoc, peerSync);

		expect(peerDoc.agentsById.main?.sessionId).toBe("sess-reset");
		expect(peerDoc.agentsById.main?.live.statusMessage).toBeUndefined();
	});

	it("models session state as semantic agent view data instead of a root snapshot", () => {
		const hub = new HubViewDocument();
		hub.updateSession(createLargeSnapshot("sess-large", false), "main");
		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();

		let result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		hubSync = result.hubSync;
		peerDoc = result.peerDoc;
		peerSync = result.peerSync;
		expect("session" in peerDoc).toBe(false);
		expect(getMessageText(peerDoc, "main", 0)).toHaveLength(1_000_000);

		hub.updateSession(createLargeSnapshot("sess-large", true), "main");
		result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		expect(result.peerDoc.agentsById.main?.status.isRunning).toBe(true);
		expect(result.hubBytes).toBeLessThan(10_000);
	});

	it("projects run timing entries as ordered timeline items instead of status side data", () => {
		const hub = new HubViewDocument();
		const assistantMessage = createAssistantMessage("answer");
		hub.updateSession(
			{
				...createSnapshot("sess-timeline", false),
				entries: [
					{
						type: "message",
						id: "assistant-entry",
						parentId: null,
						timestamp: "2026-04-27T00:00:03.000Z",
						message: assistantMessage,
					},
					{
						type: "custom",
						id: "timing-entry",
						parentId: "assistant-entry",
						timestamp: "2026-04-27T00:00:04.000Z",
						customType: "run_timing",
						data: {
							startedAt: "2026-04-27T00:00:01.000Z",
							endedAt: "2026-04-27T00:00:04.000Z",
							durationMs: 3_000,
							endReason: "completed",
						},
					},
				],
				context: { messages: [assistantMessage], thinkingLevel: "off", model: null },
			},
			"main",
		);

		const agent = hub.getSnapshot().agentsById.main as NonNullable<HubViewDocumentState["agentsById"]["main"]> & {
			status: Record<string, unknown>;
		};
		expect(agent.items).toEqual([
			{ type: "message", message: assistantMessage },
			{
				type: "run_timing",
				timing: {
					startedAt: "2026-04-27T00:00:01.000Z",
					endedAt: "2026-04-27T00:00:04.000Z",
					durationMs: 3_000,
					endReason: "completed",
				},
			},
		]);
		expect("runTimings" in agent.status).toBe(false);
	});

	it("streams assistant body text into a stable CRDT list item", () => {
		const hub = new HubViewDocument();
		const initialText = createDeterministicText(1_000_000);
		hub.updateLiveEvent(
			{
				type: "assistant_message_start",
				messageId: "assistant:1",
				message: createAssistantMessage(initialText),
			},
			"main",
		);
		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();

		let result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		hubSync = result.hubSync;
		peerDoc = result.peerDoc;
		peerSync = result.peerSync;
		expect(getMessageText(peerDoc, "main", 0)).toHaveLength(1_000_000);

		hub.updateLiveEvent(
			{
				type: "assistant_message_update",
				messageId: "assistant:1",
				message: createAssistantMessage(`${initialText}!`),
			},
			"main",
		);
		result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		expect(getMessageText(result.peerDoc, "main", 0)).toHaveLength(1_000_001);
		expect(result.hubBytes).toBeLessThan(10_000);
	});

	it("keeps peer MCP input schemas out of the CRDT view", () => {
		const hub = new HubViewDocument();
		const largeSchema = { type: "object", description: createDeterministicText(180_000) };
		hub.updatePeers([
			{
				agentId: "main",
				peerId: "peer-1",
				socketId: "socket-1",
				protocolVersion: 3,
				executorEnabled: true,
				tools: ["remote-tool"],
				connectedAt: "2026-04-27T00:00:00.000Z",
				transport: "socket.io",
				mcpSnapshot: {
					servers: [
						{
							name: "remote",
							transport: "stdio",
							status: "running",
							capabilities: {
								tools: [{ name: "remote-tool", description: "tool", inputSchema: largeSchema }],
								resources: [],
								prompts: [],
							},
						},
					],
				},
			},
		]);

		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();
		let result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		hubSync = result.hubSync;
		peerDoc = result.peerDoc;
		peerSync = result.peerSync;

		expect(JSON.stringify(peerDoc.peers)).not.toContain("inputSchema");
		expect(result.hubBytes).toBeLessThan(10_000);

		hub.updateSessionEvent({
			type: "run_state_changed",
			seq: 1,
			timestamp: "2026-04-27T00:00:01.000Z",
			isRunning: true,
			runStartedAt: "2026-04-27T00:00:01.000Z",
			lastRunStartedAt: "2026-04-27T00:00:01.000Z",
		});
		result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		expect(result.hubBytes).toBeLessThan(10_000);
	});

	it("applies user and tool-result messages from CRDT events without a session snapshot", () => {
		const hub = new HubViewDocument();
		hub.updateLiveEvent(
			{
				type: "message_start",
				messageId: "user:1",
				message: {
					role: "user",
					content: "hi",
					timestamp: 1,
				},
			},
			"main",
		);
		hub.updateLiveEvent(
			{
				type: "message_start",
				messageId: "tool:1",
				message: {
					role: "toolResult",
					toolCallId: "read:1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			},
			"main",
		);

		const messages = getMessages(hub.getSnapshot(), "main");
		expect(messages.map((message) => message.role)).toEqual(["user", "toolResult"]);
	});

	it("clears stale last errors when a clean run-state event arrives", () => {
		const hub = new HubViewDocument();
		hub.updateSession(createSnapshot("sess-error-clear", false), "main");
		hub.updateSessionEvent(
			{
				type: "error",
				seq: 1,
				timestamp: "2026-04-27T00:00:00.000Z",
				message: "Request was aborted",
			},
			"main",
		);
		expect(hub.getSnapshot().agentsById.main.lastError).toBe("Request was aborted");

		hub.updateSessionEvent(
			{
				type: "run_state_changed",
				seq: 2,
				timestamp: "2026-04-27T00:00:01.000Z",
				isRunning: true,
				runStartedAt: "2026-04-27T00:00:01.000Z",
				lastRunStartedAt: "2026-04-27T00:00:01.000Z",
				lastError: undefined,
			},
			"main",
		);

		expect(hub.getSnapshot().agentsById.main.lastError).toBeUndefined();
		expect(hub.getSnapshot().agentsById.main.live.statusMessage).toBeUndefined();
	});

	it("applies run-state events without changing large message list content", () => {
		const hub = new HubViewDocument();
		hub.updateLiveEvent(
			{
				type: "assistant_message_start",
				messageId: "assistant:1",
				message: createAssistantMessage(createDeterministicText(1_000_000)),
			},
			"main",
		);
		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();
		let result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		hubSync = result.hubSync;
		peerDoc = result.peerDoc;
		peerSync = result.peerSync;

		hub.updateSessionEvent(
			{
				type: "run_state_changed",
				seq: 1,
				timestamp: "2026-04-27T00:00:01.000Z",
				isRunning: true,
				runStartedAt: "2026-04-27T00:00:01.000Z",
				lastRunStartedAt: "2026-04-27T00:00:01.000Z",
			},
			"main",
		);

		result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		expect(result.peerDoc.agentsById.main.status.isRunning).toBe(true);
		expect(getMessageText(result.peerDoc, "main", 0)).toHaveLength(1_000_000);
		expect(result.hubBytes).toBeLessThan(10_000);
	});

	it("keeps streaming updates incremental even when adapter message ids change", () => {
		const hub = new HubViewDocument();
		const initialText = createDeterministicText(1_000_000);
		hub.updateLiveEvent(
			{
				type: "assistant_message_start",
				messageId: "assistant-live:1",
				message: createAssistantMessage(initialText, 1),
			},
			"main",
		);
		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();

		let result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		hubSync = result.hubSync;
		peerDoc = result.peerDoc;
		peerSync = result.peerSync;

		hub.updateLiveEvent(
			{
				type: "assistant_message_update",
				messageId: "assistant-live:2",
				message: createAssistantMessage(`${initialText}!`, 2),
			},
			"main",
		);
		result = exchangeWithBytes(hub, hubSync, peerDoc, peerSync);
		expect(getMessages(result.peerDoc, "main")).toHaveLength(1);
		expect(getMessageText(result.peerDoc, "main", 0)).toHaveLength(1_000_001);
		expect(result.hubBytes).toBeLessThan(10_000);
	});

	it("does not backfill persisted entries into the runtime message list", () => {
		const hub = new HubViewDocument();
		hub.resetSession(createSnapshot("sess-same-timestamp", false), "main");
		hub.updateLiveEvent(
			{
				type: "assistant_message_end",
				messageId: "assistant-live:first",
				message: createAssistantMessage("first", 1),
			},
			"main",
		);
		hub.updateSession(
			{
				...createSnapshot("sess-same-timestamp", false),
				entries: [
					{
						type: "message",
						id: "assistant-entry:second",
						parentId: null,
						timestamp: "1970-01-01T00:00:00.001Z",
						message: createAssistantMessage("second", 1),
					},
				],
				context: { messages: [createAssistantMessage("second", 1)], thinkingLevel: "off", model: null },
			},
			"main",
		);

		expect(getMessages(hub.getSnapshot(), "main")).toHaveLength(1);
		expect(getMessageText(hub.getSnapshot(), "main", 0)).toBe("first");
	});

	it("uses persisted entries only when resetting a session view", () => {
		const hub = new HubViewDocument();
		hub.updateLiveEvent(
			{
				type: "assistant_message_start",
				messageId: "assistant-live:1",
				message: createAssistantMessage("hello", 2),
			},
			"main",
		);
		hub.resetSession(createUserThenAssistantSnapshot(), "main");

		expect(getMessages(hub.getSnapshot(), "main").map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("limits initial session view history to the latest 500 messages", () => {
		const hub = new HubViewDocument();

		hub.resetSession(createManyUserMessagesSnapshot("sess-window", 505), "main");

		const messages = getMessages(hub.getSnapshot(), "main");
		expect(messages).toHaveLength(500);
		expect(messages[0]?.role === "user" ? messages[0].content : "").toBe("msg-5");
		expect(messages[499]?.role === "user" ? messages[499].content : "").toBe("msg-504");
	});

	it("keeps live-appended message history capped at 500 messages", () => {
		const hub = new HubViewDocument();
		hub.resetSession(createManyUserMessagesSnapshot("sess-live-window", 500), "main");

		hub.updateLiveEvent(
			{
				type: "message_start",
				messageId: "user:500",
				message: {
					role: "user",
					content: "msg-500",
					timestamp: 500,
				},
			},
			"main",
		);

		const messages = getMessages(hub.getSnapshot(), "main");
		expect(messages).toHaveLength(500);
		expect(messages[0]?.role === "user" ? messages[0].content : "").toBe("msg-1");
		expect(messages[499]?.role === "user" ? messages[499].content : "").toBe("msg-500");
	});

	it("clears completed live tool executions when a run finishes", () => {
		const hub = new HubViewDocument();
		hub.resetSession(createSnapshot("sess-live-tool-clear", true), "main");
		hub.updateLiveEvent(
			{
				type: "tool_execution_start",
				toolCallId: "call-done",
				toolName: "bash",
				args: { command: "pwd" },
			},
			"main",
		);
		hub.updateLiveEvent(
			{
				type: "tool_execution_end",
				toolCallId: "call-done",
				toolName: "bash",
				result: { content: [{ type: "text", text: "/tmp/pi" }], details: undefined },
				isError: false,
			},
			"main",
		);
		expect(hub.getSnapshot().agentsById.main?.live.toolOrder).toEqual(["call-done"]);

		hub.updateSessionEvent(
			{
				type: "run_state_changed",
				seq: 1,
				timestamp: "2026-04-27T00:00:01.000Z",
				isRunning: false,
			},
			"main",
		);

		expect(hub.getSnapshot().agentsById.main?.live.toolOrder).toEqual([]);
		expect(hub.getSnapshot().agentsById.main?.live.toolsById).toEqual({});
	});

	it("rejects peer sync messages that contain document changes", () => {
		const hub = new HubViewDocument();
		hub.updateSession(createSnapshot("sess-a", false), "main");
		let peerDoc = Automerge.init<HubViewDocumentState>();
		let peerSync = Automerge.initSyncState();
		let hubSync = hub.createSyncState();
		[hubSync, peerDoc, peerSync] = exchange(hub, hubSync, peerDoc, peerSync);

		peerDoc = Automerge.change(peerDoc, (doc) => {
			doc.agentsById.main.status.isRunning = true;
		});
		const maliciousMessage = createLegacySyncMessageWithChanges(peerDoc);
		expect(maliciousMessage).toBeInstanceOf(Uint8Array);

		expect(() => hub.receiveSyncMessage(hubSync, maliciousMessage)).toThrow(/read-only/);
		expect(hub.getSnapshot().agentsById.main?.sessionId).toBe("sess-a");
		expect(peerSync).toBeDefined();
	});

	it("accepts peer sync acknowledgements after the hub document advances", () => {
		const hub = new HubViewDocument();
		hub.updateSession(createSnapshot("sess-a", false), "main");
		let hubSync = hub.createSyncState();

		const acknowledgement = createLegacySyncAcknowledgement();

		hub.updateSession(createSnapshot("sess-a", true), "main");

		expect(() => {
			hubSync = hub.receiveSyncMessage(hubSync, acknowledgement);
		}).not.toThrow();
		expect(hub.getSnapshot().agentsById.main?.status.isRunning).toBe(true);
		expect(hubSync).toBeDefined();
	});

	it("compacts Automerge history without changing the current view state", () => {
		const hub = new HubViewDocument();
		hub.resetSession(createSnapshot("sess-compact", false), "main");
		for (let i = 0; i < 25; i += 1) {
			hub.updateLiveEvent({ type: "status", message: `stream-${i}` }, "main");
		}
		const beforeSnapshot = Automerge.toJS(hub.getSnapshot());
		const beforeChangeCount = hub.getChangeCount();

		hub.compactHistory();

		expect(Automerge.toJS(hub.getSnapshot())).toEqual(beforeSnapshot);
		expect(hub.getChangeCount()).toBeLessThan(beforeChangeCount);
		expect(hub.getSnapshot().agentsById.main?.live.statusMessage).toBe("stream-24");
	});
});

function createUserThenAssistantSnapshot(): HubSessionSnapshot {
	const snapshot = createSnapshot("sess-a", false);
	return {
		...snapshot,
		entries: [
			{
				type: "message",
				id: "user-entry",
				parentId: null,
				timestamp: "1970-01-01T00:00:01.000Z",
				message: {
					role: "user",
					content: "hi",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "assistant-entry",
				parentId: "user-entry",
				timestamp: "1970-01-01T00:00:02.000Z",
				message: createAssistantMessage("hello", 2),
			},
		],
	};
}

function createManyUserMessagesSnapshot(id: string, count: number): HubSessionSnapshot {
	const snapshot = createSnapshot(id, false);
	const entries = Array.from({ length: count }, (_, index) => ({
		type: "message" as const,
		id: `user-entry-${index}`,
		parentId: index === 0 ? null : `user-entry-${index - 1}`,
		timestamp: new Date(index).toISOString(),
		message: {
			role: "user" as const,
			content: `msg-${index}`,
			timestamp: index,
		},
	}));
	return {
		...snapshot,
		entries,
		context: { ...snapshot.context, messages: entries.map((entry) => entry.message) },
	};
}

function createAssistantMessage(text: string, timestamp = 1) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

function getMessageText(doc: HubViewDocumentState, agentId: string, messageIndex: number): string {
	const message = getMessages(doc, agentId)[messageIndex];
	if (!message || message.role !== "assistant") {
		return "";
	}
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function getMessages(doc: HubViewDocumentState, agentId: string) {
	return (doc.agentsById[agentId]?.items ?? []).flatMap((item) => (item.type === "message" ? [item.message] : []));
}

function exchange(
	hub: HubViewDocument,
	hubSync: HubViewProjectionState,
	peerDoc: Automerge.Doc<HubViewDocumentState>,
	peerSync: Automerge.SyncState,
): [HubViewProjectionState, Automerge.Doc<HubViewDocumentState>, Automerge.SyncState] {
	let sentMessage = false;
	for (let i = 0; i < 8; i += 1) {
		const outgoing = hub.generateSyncMessage(hubSync);
		hubSync = outgoing.syncState;
		if (!outgoing.message) {
			break;
		}
		sentMessage = true;
		peerDoc = applyProjectionMessage(peerDoc, outgoing);
	}
	expect(sentMessage).toBe(true);
	return [hubSync, peerDoc, peerSync];
}

function exchangeWithBytes(
	hub: HubViewDocument,
	hubSync: HubViewProjectionState,
	peerDoc: Automerge.Doc<HubViewDocumentState>,
	peerSync: Automerge.SyncState,
): {
	hubSync: HubViewProjectionState;
	peerDoc: Automerge.Doc<HubViewDocumentState>;
	peerSync: Automerge.SyncState;
	hubBytes: number;
} {
	let sentMessage = false;
	let hubBytes = 0;
	for (let i = 0; i < 8; i += 1) {
		const outgoing = hub.generateSyncMessage(hubSync);
		hubSync = outgoing.syncState;
		if (!outgoing.message) {
			break;
		}
		sentMessage = true;
		hubBytes += outgoing.message.byteLength;
		peerDoc = applyProjectionMessage(peerDoc, outgoing);
	}
	expect(sentMessage).toBe(true);
	return { hubSync, peerDoc, peerSync, hubBytes };
}

function applyProjectionMessage(
	peerDoc: Automerge.Doc<HubViewDocumentState>,
	message: HubViewSyncMessage,
): Automerge.Doc<HubViewDocumentState> {
	if (!message.message) {
		return peerDoc;
	}
	if (message.format === "snapshot") {
		return Automerge.load<HubViewDocumentState>(message.message);
	}
	return Automerge.loadIncremental(peerDoc, message.message);
}

function createLegacySyncAcknowledgement(): Uint8Array {
	const doc = Automerge.init<HubViewDocumentState>();
	const [_sync, message] = Automerge.generateSyncMessage(doc, Automerge.initSyncState());
	if (!message) {
		throw new Error("Expected legacy sync acknowledgement message.");
	}
	return message;
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
