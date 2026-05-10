import { describe, expect, it, vi } from "vitest";
import { parsePeerCommand } from "../../src/peer/commands/index.js";
import { ForkedInteractiveMode } from "../../src/peer/tui/forked/interactive-mode.js";
import type { RemoteInteractiveActions } from "../../src/peer/tui/interactive/remote-interactive-actions.js";
import type { RemoteInteractiveCapabilities } from "../../src/peer/tui/interactive/remote-interactive-capabilities.js";
import type { RemoteInteractiveView } from "../../src/peer/tui/interactive/remote-interactive-view.js";

function createActions(): RemoteInteractiveActions {
	return {
		submitPrompt: vi.fn(async () => {}),
		submitFollowUp: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(async () => {}),
		invokeCommand: vi.fn(async () => {}),
		getSessionSources: vi.fn(async () => []),
		pauseSource: vi.fn(async () => []),
		restartSource: vi.fn(async () => []),
		removeSource: vi.fn(async () => []),
		getMcpServers: vi.fn(async () => ({ servers: [] })),
		pauseMcpServer: vi.fn(async () => []),
		restartMcpServer: vi.fn(async () => []),
		removeMcpServer: vi.fn(async () => []),
	};
}

function createCapabilities(): RemoteInteractiveCapabilities {
	return {
		supportsCompact: true,
		supportsReload: true,
		supportsModelSelection: true,
		supportsSessionTree: false,
		supportsSessionCreation: false,
		supportsSessionResume: false,
		supportsSessionFork: false,
		supportsSessionClone: false,
	};
}

function createView(): RemoteInteractiveView {
	return {
		connection: { state: "connected", message: "Connected to hub." },
		welcome: {
			sessionId: "session-12345678",
			peerId: "peer-a",
			agentId: "root",
			hubVersion: "0.69.0",
			protocolVersion: 4,
			toolNames: ["read"],
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
		},
		session: {
			header: {
				type: "session",
				id: "session-12345678",
				timestamp: "2026-04-24T00:00:00.000Z",
				version: 1,
				cwd: "/tmp/workspace",
			},
			sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
			items: [],
			availableModels: [{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true }],
			availableThinkingLevels: ["off", "high"],
			isRunning: true,
			pendingToolCallIds: [],
			queuedMessages: [
				{ text: "之后补一句", messageSource: { kind: "peer", name: "peer-a" } },
				{ text: "最后总结一下", messageSource: { kind: "peer", name: "peer-a" } },
				{ text: "先修正这一段", messageSource: { kind: "peer", name: "peer-a" } },
			],
			model: { provider: "openai", modelId: "gpt-4.1" },
			thinkingLevel: "high",
			diagnostics: [],
		},
		live: {
			toolExecutions: [],
		},
		peers: [],
		footer: {
			cwd: "/tmp/workspace",
			modelLabel: "openai/gpt-4.1",
			queueSummary: "queued 3",
			pendingToolCount: 0,
			peerCount: 0,
			isRunning: true,
			peerId: "peer-a",
			boundAgentId: "main",
			sessionId: "session-12345678",
		},
		status: { diagnostics: [] },
		commands: [],
	};
}

function renderChildrenText(children: Array<{ render: (width: number) => string[] }>): string {
	return children.flatMap((child) => child.render(120)).join("\n");
}

describe("command shell parity", () => {
	it("surfaces queue state in the header", () => {
		const view = createView();
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).renderFromState();
		const text = renderChildrenText((mode as any).headerContainer.children);

		expect(text).not.toContain("Queued:");
		expect(text).not.toContain("follow-up 2");
		expect(text).not.toContain("steering");
	});

	it("renders a visible working status area and preserves idle spacing above the editor", () => {
		const runningView = createView();
		const runningMode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => runningView,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(runningMode as any).renderFromState();
		const runningStatusText = renderChildrenText((runningMode as any).statusContainer.children);
		expect(runningStatusText).toContain("Working");

		const idleView = {
			...createView(),
			session: {
				...createView().session!,
				isRunning: false,
				queuedMessages: [],
			},
			footer: {
				...createView().footer,
				isRunning: false,
				queueSummary: "queued 0",
			},
		};
		const idleMode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => idleView,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(idleMode as any).renderFromState();
		expect(
			(idleMode as any).statusContainer.children.map(
				(child: { constructor: { name: string } }) => child.constructor.name,
			),
		).toEqual(["Spacer"]);
	});

	it("renders queued peer messages", () => {
		const view = createView();
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).renderFromState();
		const text = renderChildrenText((mode as any).pendingMessagesContainer.children);

		expect(text).toContain("Queued [peer/peer-a]: 之后补一句");
		expect(text).toContain("Queued [peer/peer-a]: 最后总结一下");
		expect(text).toContain("Queued [peer/peer-a]: 先修正这一段");
		expect(text).toContain("edit queued messages");
	});

	it("renders disabled commands as a named command block with explanation", async () => {
		const view = createView();
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		const command = parsePeerCommand("/fork");
		expect(command).toEqual({
			kind: "disabled",
			commandName: "fork",
			message: 'Session branching is not enabled in D-Pi hub yet. "/fork" is unavailable right now.',
		});

		await (mode as any).handleParsedCommand(command);
		const text = renderChildrenText((mode as any).chatContainer.children);

		expect(text).toContain("/fork");
		expect(text).toContain("Session branching is not enabled in D-Pi hub yet");
	});
});
