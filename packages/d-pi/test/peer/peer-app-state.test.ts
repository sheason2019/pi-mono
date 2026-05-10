import { describe, expect, it } from "vitest";
import {
	type HubSessionSnapshot,
	HubViewDocument,
	type HubViewDocumentState,
	type HubViewProjectionState,
} from "../../src/hub/index.js";
import { PeerAppState } from "../../src/peer/state/peer-app-state.js";

function createSnapshot(id: string): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id,
			timestamp: "2026-04-28T00:00:00.000Z",
			cwd: "/tmp/pi-peer",
			version: 3,
		},
		sessionFile: "/tmp/pi-peer/.pi-hub/session.jsonl",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning: false,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

function syncHubToApp(
	hub: HubViewDocument,
	app: PeerAppState,
	syncState: HubViewProjectionState = hub.createSyncState(),
): HubViewProjectionState {
	for (let i = 0; i < 8; i += 1) {
		const outgoing = hub.generateSyncMessage(syncState);
		syncState = outgoing.syncState;
		if (!outgoing.message) {
			return syncState;
		}
		app.applyCrdtSyncMessage(outgoing.message, outgoing.format);
	}
	return syncState;
}

function createWelcome(sessionId: string) {
	return {
		sessionId,
		peerId: "peer-a",
		agentId: "root",
		hubVersion: "0.69.0",
		protocolVersion: 4,
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

describe("PeerAppState", () => {
	it("resets CRDT state when a new hub welcome arrives", () => {
		const firstHub = new HubViewDocument();
		firstHub.resetSession(createSnapshot("session-one"), "root");
		const app = new PeerAppState();
		app.applyWelcome(createWelcome("session-one"));
		syncHubToApp(firstHub, app);
		expect(app.getSnapshot().selectedAgent?.sessionId).toBe("session-one");

		const secondHub = new HubViewDocument();
		secondHub.resetSession(createSnapshot("session-two"), "root");
		app.applyWelcome(createWelcome("session-two"));
		expect(() => syncHubToApp(secondHub, app)).not.toThrow();
		expect(app.getSnapshot().selectedAgent?.sessionId).toBe("session-two");
		expect(JSON.stringify(app.getSnapshot().view as HubViewDocumentState)).not.toContain("session-one");
	});

	it("applies hub CRDT sync without returning an optimistic delivery acknowledgement", () => {
		const hub = new HubViewDocument();
		hub.resetSession(createSnapshot("session-no-ack"), "root");
		const app = new PeerAppState();
		app.applyWelcome(createWelcome("session-no-ack"));
		const outgoing = hub.generateSyncMessage(hub.createSyncState());
		expect(outgoing.message).toBeDefined();

		const result = app.applyCrdtSyncMessage(outgoing.message!, outgoing.format);

		expect("response" in result).toBe(false);
		expect(app.getSnapshot().selectedAgent?.sessionId).toBe("session-no-ack");
	});

	it("keeps a live source user message visible when the persisted session entry arrives", () => {
		const hub = new HubViewDocument();
		const sourceMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "from source" }],
			timestamp: 1234,
			messageSource: { kind: "source" as const, name: "cli" },
		};
		hub.resetSession({ ...createSnapshot("session-source"), isRunning: true }, "root");
		const app = new PeerAppState();
		app.applyWelcome(createWelcome("session-source"));
		let syncState = syncHubToApp(hub, app);

		hub.updateLiveEvent({ type: "message_start", messageId: "live-source-message", message: sourceMessage }, "root");
		syncState = syncHubToApp(hub, app, syncState);
		expect(getMessages(app.getSnapshot().selectedAgent)).toHaveLength(1);

		hub.updateSession(
			{
				...createSnapshot("session-source"),
				isRunning: true,
				entries: [
					{
						type: "message",
						id: "persisted-source-entry",
						parentId: null,
						timestamp: "2026-04-28T00:00:00.000Z",
						message: sourceMessage,
					},
				],
				context: { messages: [sourceMessage], thinkingLevel: "off", model: null },
			},
			"root",
		);
		syncHubToApp(hub, app, syncState);

		const messages = getMessages(app.getSnapshot().selectedAgent);
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages)).toContain("from source");
		expect(JSON.stringify(messages)).toContain("source");
	});

	it("projects the CRDT streaming assistant message index", () => {
		const hub = new HubViewDocument();
		const app = new PeerAppState();
		app.applyWelcome(createWelcome("session-streaming"));
		hub.resetSession(createSnapshot("session-streaming"), "root");
		let syncState = syncHubToApp(hub, app);

		hub.updateLiveEvent(
			{
				type: "assistant_message_start",
				messageId: "assistant-live",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			},
			"root",
		);
		syncState = syncHubToApp(hub, app, syncState);

		expect(app.getSnapshot().live.streamingMessageId).toBe("assistant-live");
		expect(app.getSnapshot().live.streamingMessageIndex).toBe(0);
	});

	it("coalesces multiple CRDT sync applies into one listener notification per tick", async () => {
		const hub = new HubViewDocument();
		const app = new PeerAppState();
		app.applyWelcome(createWelcome("session-coalesce"));
		const snapshots: unknown[] = [];
		app.subscribe((snapshot) => snapshots.push(snapshot));

		hub.resetSession(createSnapshot("session-coalesce"), "root");
		let syncState = hub.createSyncState();
		let outgoing = hub.generateSyncMessage(syncState);
		syncState = outgoing.syncState;
		expect(outgoing.message).toBeDefined();
		app.applyCrdtSyncMessage(outgoing.message!, outgoing.format);

		hub.updateLiveEvent(
			{
				type: "status",
				message: "streaming",
			},
			"root",
		);
		outgoing = hub.generateSyncMessage(syncState);
		expect(outgoing.message).toBeDefined();
		app.applyCrdtSyncMessage(outgoing.message!, outgoing.format);

		expect(snapshots).toHaveLength(0);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(snapshots).toHaveLength(1);
		expect(app.getSnapshot().live.statusMessage).toBe("streaming");
	});
});

function getMessages(agent: ReturnType<PeerAppState["getSnapshot"]>["selectedAgent"]) {
	return (agent?.items ?? []).flatMap((item) => (item.type === "message" ? [item.message] : []));
}
