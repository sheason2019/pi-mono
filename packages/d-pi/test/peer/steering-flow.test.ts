import { describe, expect, it, vi } from "vitest";
import { ForkedInteractiveMode } from "../../src/peer/tui/forked/interactive-mode.js";
import type { RemoteInteractiveActions } from "../../src/peer/tui/interactive/remote-interactive-actions.js";
import type { RemoteInteractiveCapabilities } from "../../src/peer/tui/interactive/remote-interactive-capabilities.js";
import type { RemoteInteractiveView } from "../../src/peer/tui/interactive/remote-interactive-view.js";

interface ModeHarness {
	editor: {
		onSubmit?: (text: string) => void | Promise<void>;
		setText(text: string): void;
		actionHandlers: Map<string, () => void | Promise<void>>;
	};
}

function createActions(): RemoteInteractiveActions {
	return {
		queueWrite: vi.fn(async () => {}),
		queueFlush: vi.fn(async () => {}),
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

function createView(
	isRunning: boolean,
	queuedMessages: NonNullable<RemoteInteractiveView["session"]>["queuedMessages"] = [],
): RemoteInteractiveView {
	return {
		connection: { state: "connected", message: "Connected" },
		peers: [],
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
			isRunning,
			pendingToolCallIds: [],
			queuedMessages,
			model: { provider: "openai", modelId: "gpt-4.1" },
			thinkingLevel: "high",
			diagnostics: [],
		},
		live: {
			toolExecutions: [],
		},
		footer: {
			cwd: "/tmp/workspace",
			modelLabel: "openai/gpt-4.1",
			queueSummary: `queued ${queuedMessages.length}`,
			pendingToolCount: 0,
			peerCount: 0,
			isRunning,
			peerId: "peer-a",
			boundAgentId: "main",
		},
		status: { diagnostics: [] },
		commands: [],
	};
}

function createMode(view: RemoteInteractiveView, actions: RemoteInteractiveActions): ForkedInteractiveMode {
	return new ForkedInteractiveMode({
		peerId: "peer-a",
		cwd: "/tmp/workspace",
		getView: () => view,
		actions,
		capabilities: createCapabilities(),
		getDraft: () => "",
		setDraft: (_draft: string) => {},
		subscribe: (_listener: () => void) => () => {},
	});
}

describe("queue flow", () => {
	it("routes Enter submissions to queue_write while the hub is running", async () => {
		const actions = createActions();
		const mode = createMode(createView(true), actions);
		const harness = mode as unknown as ModeHarness;

		await harness.editor.onSubmit?.("马上修正这个回答");

		expect(actions.queueWrite).toHaveBeenCalledWith("马上修正这个回答");
		expect(actions.steer).not.toHaveBeenCalled();
		expect(actions.submitPrompt).not.toHaveBeenCalled();
		expect(actions.submitFollowUp).not.toHaveBeenCalled();
	});

	it("keeps alt+enter on the same input queue while the hub is running", async () => {
		const actions = createActions();
		const mode = createMode(createView(true), actions);
		const harness = mode as unknown as ModeHarness;

		harness.editor.setText("之后再补一句");
		harness.editor.actionHandlers.get("app.message.followUp")?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(actions.queueWrite).toHaveBeenCalledWith("之后再补一句");
		expect(actions.submitFollowUp).not.toHaveBeenCalled();
		expect(actions.steer).not.toHaveBeenCalled();
	});

	it("queues alt+enter the same way when the hub is idle", async () => {
		const actions = createActions();
		const mode = createMode(createView(false), actions);
		const harness = mode as unknown as ModeHarness;

		harness.editor.setText("空闲时直接发送");
		harness.editor.actionHandlers.get("app.message.followUp")?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(actions.queueWrite).toHaveBeenCalledWith("空闲时直接发送");
		expect(actions.submitPrompt).not.toHaveBeenCalled();
		expect(actions.submitFollowUp).not.toHaveBeenCalled();
		expect(actions.steer).not.toHaveBeenCalled();
	});

	it("flushes queued messages on escape before aborting a running agent", async () => {
		const actions = createActions();
		const mode = createMode(
			createView(true, [{ text: "排队内容", messageSource: { kind: "peer", name: "peer-a" } }]),
			actions,
		);
		const harness = mode as unknown as { editor: { onEscape?: () => void } };

		harness.editor.onEscape?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(actions.queueFlush).toHaveBeenCalledOnce();
		expect(actions.abort).not.toHaveBeenCalled();
	});
});
