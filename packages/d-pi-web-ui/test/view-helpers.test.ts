import { describe, expect, it } from "vitest";
import type { HubAgentViewModel, HubViewDocumentState } from "../src/d-pi-hub.js";
import {
	createAgentPath,
	formatMessageSourceLabel,
	formatMessageSourceTooltip,
	getComposerActionView,
	getHeaderAgentId,
	getSelectableAgentIds,
	getSelectedAgentIsRunning,
} from "../src/view-helpers.js";

function createView(agentOrder: string[]): HubViewDocumentState {
	return {
		version: 1,
		agentOrder,
		agentsById: Object.fromEntries(agentOrder.map((agentId) => [agentId, createAgent(agentId)])),
		peers: [],
	};
}

function createAgent(agentId: string): HubAgentViewModel {
	return {
		agentId,
		status: { isRunning: false },
		queue: { messages: [], size: 0 },
		context: { model: null, thinkingLevel: "off", pendingToolCallIds: [] },
		items: [],
		live: { statusMessage: undefined, itemIndicesById: {}, toolsById: {}, toolOrder: [], activeToolCallIds: [] },
		availableModels: [],
		availableThinkingLevels: [],
		diagnostics: [],
		mcpServers: [],
		sources: [],
	};
}

describe("D-Pi Web UI view helpers", () => {
	it("builds selectable agent ids from the CRDT view and current selection", () => {
		expect(getSelectableAgentIds(createView(["main", "child-a"]), "child-a")).toEqual(["main", "child-a"]);
		expect(getSelectableAgentIds(createView(["main"]), "child-a")).toEqual(["main", "child-a"]);
		expect(getSelectableAgentIds(createView([]), "main")).toEqual(["main"]);
	});

	it("falls back to the selected agent before the initial CRDT view arrives", () => {
		expect(getSelectableAgentIds({} as HubViewDocumentState, "main")).toEqual(["main"]);
		expect(getSelectableAgentIds({} as HubViewDocumentState, "child-a")).toEqual(["child-a"]);
	});

	it("keeps the user-selected header agent over a stale snapshot agent", () => {
		expect(getHeaderAgentId("child-a", "main")).toBe("child-a");
		expect(getHeaderAgentId("main", "child-a")).toBe("main");
	});

	it("creates canonical agent paths for UI switching", () => {
		expect(createAgentPath("main")).toBe("/");
		expect(createAgentPath("child a")).toBe("/agents/child%20a");
	});

	it("reads the selected agent working state from the CRDT view", () => {
		const view = createView(["main", "child-a"]);
		view.agentsById.main.status.isRunning = true;

		expect(getSelectedAgentIsRunning(view, "main")).toBe(true);
		expect(getSelectedAgentIsRunning(view, "child-a")).toBe(false);
		expect(getSelectedAgentIsRunning(view, "missing")).toBe(false);
	});

	it("builds composer action metadata for send and interrupt states", () => {
		expect(getComposerActionView({ isConnected: true, isRunning: false, inputValue: "hello" })).toEqual({
			kind: "send",
			ariaLabel: "Send message",
			title: "Send message",
			buttonClass: "btn btn-primary btn-circle btn-sm",
			icon: "send",
			disabled: false,
			hint: "Enter to send, Shift+Enter for newline.",
		});
		expect(getComposerActionView({ isConnected: true, isRunning: false, inputValue: " " }).disabled).toBe(true);
		expect(getComposerActionView({ isConnected: true, isRunning: true, inputValue: "" })).toEqual({
			kind: "interrupt",
			ariaLabel: "Interrupt response",
			title: "Interrupt response",
			buttonClass: "btn btn-error btn-circle btn-sm",
			icon: "stop",
			disabled: false,
			hint: "Response in progress. Click stop to interrupt.",
		});
		expect(getComposerActionView({ isConnected: false, isRunning: true, inputValue: "" }).disabled).toBe(true);
	});

	it("formats message source labels for display", () => {
		expect(formatMessageSourceLabel({ kind: "host", name: "web-abc" })).toBe("host/web-abc");
		expect(formatMessageSourceLabel({ kind: "peer", name: "laptop" })).toBe("peer/laptop");
		expect(formatMessageSourceLabel(undefined)).toBeUndefined();
	});

	it("formats message source tooltip text", () => {
		expect(formatMessageSourceTooltip("host/web-abc")).toBe("该消息发送自节点 host/web-abc");
		expect(formatMessageSourceTooltip(undefined)).toBeUndefined();
	});
});
