import { describe, expect, it, vi } from "vitest";
import { theme } from "../../src/peer/tui/components/index.js";
import { ForkedInteractiveMode, updateAssistantComponentContent } from "../../src/peer/tui/forked/interactive-mode.js";
import type { RemoteInteractiveActions } from "../../src/peer/tui/interactive/remote-interactive-actions.js";
import type { RemoteInteractiveCapabilities } from "../../src/peer/tui/interactive/remote-interactive-capabilities.js";
import type { RemoteInteractiveView } from "../../src/peer/tui/interactive/remote-interactive-view.js";

type TestMessage = NonNullable<RemoteInteractiveView["session"]>["items"][number] extends infer Item
	? Item extends { type: "message"; message: infer Message }
		? Message
		: never
	: never;

type ViewOverrides = Partial<Omit<RemoteInteractiveView, "session" | "live">> & {
	session?: Partial<NonNullable<RemoteInteractiveView["session"]>> & { messages?: TestMessage[] };
	live?: Partial<NonNullable<RemoteInteractiveView["live"]>>;
};

function createView(partial: ViewOverrides = {}): RemoteInteractiveView {
	const { session: sessionOverride, live: liveOverride, ...rest } = partial;
	const { messages, ...sessionRest } = sessionOverride ?? {};
	const baseSession = {
		header: {
			type: "session" as const,
			id: "session-12345678",
			timestamp: "2026-04-24T00:00:00.000Z",
			version: 1,
			cwd: "/tmp/workspace",
		},
		sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
		items: [],
		availableModels: [],
		availableThinkingLevels: [],
		isRunning: false,
		pendingToolCallIds: [],
		model: { provider: "openai", modelId: "gpt-4.1" },
		thinkingLevel: "high",
		diagnostics: [],
	};
	const baseLive = {
		toolExecutions: [],
	};

	return {
		connection: { state: "connected", message: "Connected" },
		peers: [],
		session: {
			...baseSession,
			...sessionRest,
			items:
				sessionRest.items ??
				messages?.map((message) => ({ type: "message" as const, message })) ??
				baseSession.items,
		},
		live: liveOverride ? { ...baseLive, ...liveOverride } : baseLive,
		footer: {
			cwd: "/tmp/workspace",
			modelLabel: "openai/gpt-4.1",
			queueSummary: "follow-up 0, steering 0",
			pendingToolCount: 0,
			peerCount: 0,
			isRunning: false,
			peerId: "peer-a",
			boundAgentId: "main",
		},
		status: { diagnostics: [] },
		commands: [],
		...rest,
	};
}

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

function getChatChildren(
	mode: ForkedInteractiveMode,
): Array<{ constructor: { name: string }; render: (width: number) => string[] }> {
	return (mode as any).chatContainer.children;
}

describe("forked streaming render", () => {
	it("coalesces bursty state changes into a single render tick", async () => {
		const view = createView();
		let listener: (() => void) | undefined;
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (nextListener: () => void) => {
				listener = nextListener;
				return () => {};
			},
		});
		const renderSpy = vi
			.spyOn(mode as unknown as { renderFromState: () => void }, "renderFromState")
			.mockImplementation(() => {});

		(mode as unknown as { subscribeToState: () => void }).subscribeToState();
		listener?.();
		listener?.();
		listener?.();

		expect(renderSpy).not.toHaveBeenCalled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(renderSpy).toHaveBeenCalledTimes(1);
	});

	it("renders live assistant streaming state changes without waiting for the coalesced render tick", () => {
		const view = createView({
			session: { isRunning: true },
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "The user is greeting" }],
					api: "openai-completions",
					provider: "ark-openai-compatible",
					model: "minimax-m2",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			},
		});
		let listener: (() => void) | undefined;
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (nextListener: () => void) => {
				listener = nextListener;
				return () => {};
			},
		});
		const renderSpy = vi
			.spyOn(mode as unknown as { renderFromState: () => void }, "renderFromState")
			.mockImplementation(() => {});

		(mode as unknown as { subscribeToState: () => void }).subscribeToState();
		listener?.();
		listener?.();

		expect(renderSpy).toHaveBeenCalledTimes(2);
	});

	it("reuses the live assistant component across streaming updates", () => {
		const streamingMessage = {
			role: "assistant" as const,
			content: [{ type: "thinking" as const, thinking: "The user is greeting" }],
			api: "openai-completions",
			provider: "ark-openai-compatible",
			model: "minimax-m2",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		const view = createView({
			session: { isRunning: true },
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage,
			},
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: () => () => {},
		});

		(mode as unknown as { renderFromState: () => void }).renderFromState();
		const firstAssistant = getChatChildren(mode).find(
			(child) => child.constructor.name === "AssistantMessageComponent",
		);
		expect(firstAssistant).toBeDefined();

		streamingMessage.content[0]!.thinking = "The user is greeting again";
		(mode as unknown as { renderFromState: () => void }).renderFromState();

		const secondAssistant = getChatChildren(mode).find(
			(child) => child.constructor.name === "AssistantMessageComponent",
		);
		expect(secondAssistant).toBe(firstAssistant);
	});

	it("updates CRDT streaming assistant content without rerendering the full history", () => {
		const streamingMessage = {
			role: "assistant" as const,
			content: [{ type: "thinking" as const, thinking: "实时思考" }],
			api: "openai-completions",
			provider: "ark-openai-compatible",
			model: "minimax-m2",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		let view = createView({
			session: { isRunning: true, messages: [{ role: "user", content: "问题", timestamp: 1 }, streamingMessage] },
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage,
			},
		});
		let listener: (() => void) | undefined;
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (nextListener: () => void) => {
				listener = nextListener;
				return () => {};
			},
		});

		(mode as unknown as { renderFromState: () => void }).renderFromState();
		const renderSpy = vi.spyOn(mode as unknown as { renderFromState: () => void }, "renderFromState");
		(mode as unknown as { subscribeToState: () => void }).subscribeToState();

		const updatedStreamingMessage = {
			...streamingMessage,
			content: [{ type: "thinking" as const, thinking: "实时思考更新" }],
		};
		view = createView({
			session: {
				isRunning: true,
				messages: [{ role: "user", content: "问题", timestamp: 1 }, updatedStreamingMessage],
			},
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage: updatedStreamingMessage,
			},
		});
		listener?.();

		expect(renderSpy).not.toHaveBeenCalled();
		const assistant = getChatChildren(mode).find((child) => child.constructor.name === "AssistantMessageComponent");
		expect(assistant?.render(80).join("\n")).toContain("实时思考更新");
	});

	it("prefers assistant component incremental updates when available", () => {
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "hello world" }],
			api: "openai-completions",
			provider: "ark-openai-compatible",
			model: "minimax-m2",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		const component = {
			tryUpdateContentIncrementally: vi.fn(() => true),
			updateContent: vi.fn(),
		};

		updateAssistantComponentContent(component, message);

		expect(component.tryUpdateContentIncrementally).toHaveBeenCalledWith(message);
		expect(component.updateContent).not.toHaveBeenCalled();
	});

	it("reuses settled assistant components while live streaming updates", () => {
		const settledMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "历史回答" }],
			api: "openai-completions",
			provider: "ark-openai-compatible",
			model: "minimax-m2",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};
		const streamingMessage = {
			...settledMessage,
			content: [{ type: "thinking" as const, thinking: "实时思考" }],
			timestamp: 2,
		};
		const view = createView({
			session: { isRunning: true, messages: [settledMessage] },
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage,
			},
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: () => () => {},
		});

		(mode as unknown as { renderFromState: () => void }).renderFromState();
		const firstSettledAssistant = getChatChildren(mode).filter(
			(child) => child.constructor.name === "AssistantMessageComponent",
		)[0];
		expect(firstSettledAssistant).toBeDefined();

		streamingMessage.content[0]!.thinking = "实时思考更新";
		(mode as unknown as { renderFromState: () => void }).renderFromState();

		const secondSettledAssistant = getChatChildren(mode).filter(
			(child) => child.constructor.name === "AssistantMessageComponent",
		)[0];
		expect(secondSettledAssistant).toBe(firstSettledAssistant);
	});

	it("shows CRDT resync status next to the working indicator", () => {
		const view = createView({
			session: {
				isRunning: true,
				runStartedAt: undefined,
			},
			status: {
				diagnostics: [],
				crdtResyncMessage: "resyncing session state",
			},
		});
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

		const statusText = (mode as any).statusLoader.render(80).join("\n");
		expect(statusText).toContain("Working");
		expect(statusText).toContain("resyncing session state");
	});

	it("updates the working timer without rerendering the full view every second", () => {
		vi.useFakeTimers();
		try {
			const view = createView({
				session: {
					isRunning: true,
					runStartedAt: new Date(Date.now() - 1_000).toISOString(),
				},
			});
			const mode = new ForkedInteractiveMode({
				peerId: "peer-a",
				cwd: "/tmp/workspace",
				getView: () => view,
				actions: createActions(),
				capabilities: createCapabilities(),
				getDraft: () => "",
				setDraft: (_draft: string) => {},
				subscribe: () => () => {},
			});
			const renderSpy = vi.spyOn(mode as unknown as { renderFromState: () => void }, "renderFromState");

			(mode as unknown as { renderStatusArea: (nextView: RemoteInteractiveView) => void }).renderStatusArea(view);
			renderSpy.mockClear();

			vi.advanceTimersByTime(1_000);

			expect(renderSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders live thinking updates before the committed assistant message exists", () => {
		const view = createView({
			session: {
				messages: [
					{
						role: "user",
						content: "介绍一下你自己",
						timestamp: 1,
					},
				],
			},
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "我是一个正在思考的远端助手。" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-4.1",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			},
		});

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

		const assistant = getChatChildren(mode).find((child) => child.constructor.name === "AssistantMessageComponent");
		expect(assistant?.render(80).join("\n")).toContain("我是一个正在思考的远端助手");
	});

	it("preserves live tool execution start time when the result arrives", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
			const view = createView({
				session: {
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "sleep 2" } }],
							api: "openai-responses",
							provider: "openai",
							model: "gpt-4.1",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: 2,
						},
					],
				},
				live: {
					toolExecutions: [
						{
							toolCallId: "tool-1",
							toolName: "bash",
							args: { command: "sleep 2" },
							partialResult: { content: [{ type: "text", text: "running" }], details: undefined },
						},
					],
				},
			});
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
			vi.advanceTimersByTime(2_500);
			view.live!.toolExecutions = [
				{
					toolCallId: "tool-1",
					toolName: "bash",
					args: { command: "sleep 2" },
					result: { content: [{ type: "text", text: "done" }], details: undefined },
					isError: false,
				},
			];
			(mode as any).renderFromState();

			const tool = getChatChildren(mode).find((child) => child.constructor.name === "ToolExecutionComponent");
			expect(tool?.render(80).join("\n")).toContain("Took 2.5s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not render the same CRDT streaming assistant message twice", () => {
		const streamingMessage = {
			role: "assistant" as const,
			content: [{ type: "thinking" as const, thinking: "我正在分析这道题。" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		const view = createView({
			session: {
				messages: [{ role: "user", content: "计算球体半径", timestamp: 1 }, streamingMessage],
			},
			live: {
				streamingMessageId: "main:assistant-live:2:1",
				streamingMessage,
			},
		});

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

		const assistantComponents = getChatChildren(mode).filter(
			(child) => child.constructor.name === "AssistantMessageComponent",
		);
		expect(assistantComponents).toHaveLength(1);
		expect(assistantComponents[0]?.render(80).join("\n")).toContain("我正在分析这道题");
	});

	it("adds a spacer before follow-up user messages and converges to committed assistant output", () => {
		let view = createView({
			session: {
				messages: [
					{ role: "user", content: "第一问", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "第一答" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-4.1",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
					{ role: "user", content: "第二问", timestamp: 3 },
				],
			},
			live: {
				streamingMessageId: "assistant:4",
				streamingMessage: {
					role: "assistant",
					content: [{ type: "text", text: "第二答" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-4.1",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 4,
				},
			},
		});

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

		expect(getChatChildren(mode).map((child) => child.constructor.name)).toEqual([
			"UserMessageComponent",
			"AssistantMessageComponent",
			"Spacer",
			"UserMessageComponent",
			"AssistantMessageComponent",
		]);
		expect(getChatChildren(mode).at(-1)?.render(80).join("\n")).toContain("第二答");

		view = createView({
			session: {
				messages: [
					{ role: "user", content: "第一问", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "第一答" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-4.1",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
					{ role: "user", content: "第二问", timestamp: 3 },
					{
						role: "assistant",
						content: [{ type: "text", text: "第二答" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-4.1",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 4,
					},
				],
			},
			live: {
				toolExecutions: [],
			},
		});

		(mode as any).renderFromState();

		expect(getChatChildren(mode).map((child) => child.constructor.name)).toEqual([
			"UserMessageComponent",
			"AssistantMessageComponent",
			"Spacer",
			"UserMessageComponent",
			"AssistantMessageComponent",
		]);
		expect(getChatChildren(mode).at(-1)?.render(80).join("\n")).toContain("第二答");
	});

	it("renders messageSource labels above user message bodies (peer and source use warning style)", () => {
		const view = createView({
			session: {
				messages: [
					{
						role: "user",
						content: "from peer",
						timestamp: 1,
						messageSource: { kind: "peer", name: "alice" },
					},
					{
						role: "user",
						content: "from source",
						timestamp: 2,
						messageSource: { kind: "source", name: "cli" },
					},
				],
			},
		});

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

		const userComponents = getChatChildren(mode).filter((c) => c.constructor.name === "UserMessageComponent");
		expect(userComponents).toHaveLength(2);

		const firstLines = userComponents[0]!.render(80);
		expect(firstLines[0]).toBe(theme.fg("warning", "peer/alice"));
		expect(firstLines[0]).not.toContain("from peer");
		const peerBodyJoined = firstLines.slice(1).join("\n");
		expect(peerBodyJoined).toContain("from peer");
		expect(peerBodyJoined).not.toContain("peer/alice");

		const secondLines = userComponents[1]!.render(80);
		expect(secondLines[0]).toBe(theme.fg("warning", "source/cli"));
		expect(secondLines[0]).not.toContain("from source");
		const sourceBodyJoined = secondLines.slice(1).join("\n");
		expect(sourceBodyJoined).toContain("from source");
		expect(sourceBodyJoined).not.toContain("source/cli");
	});

	it("refreshes pending queue while live assistant streaming is rendered incrementally", () => {
		const streamingMessage = {
			role: "assistant" as const,
			content: [{ type: "thinking" as const, thinking: "我正在处理。" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 2,
		};
		let view = createView({
			session: {
				isRunning: true,
				messages: [{ role: "user", content: "问题", timestamp: 1 }, streamingMessage],
				queuedMessages: [],
			},
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage,
			},
		});
		let listener: (() => void) | undefined;
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (nextListener: () => void) => {
				listener = nextListener;
				return () => {};
			},
		});

		(mode as unknown as { renderFromState: () => void }).renderFromState();
		(mode as unknown as { subscribeToState: () => void }).subscribeToState();
		view = createView({
			session: {
				isRunning: true,
				messages: [{ role: "user", content: "问题", timestamp: 1 }, streamingMessage],
				queuedMessages: [{ text: "补充一个排队输入", messageSource: { kind: "peer", name: "peer-a" } }],
			},
			live: {
				streamingMessageId: "assistant:2",
				streamingMessage,
			},
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "queued 1",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: true,
				peerId: "peer-a",
				boundAgentId: "main",
			},
		});
		listener?.();

		const pendingText = (mode as any).pendingMessagesContainer.render(80).join("\n");
		expect(pendingText).toContain("补充一个排队输入");
	});

	it("does not rebuild long chat history for streaming text-only updates", () => {
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const history = Array.from({ length: 80 }, (_, index) =>
			index % 2 === 0
				? { role: "user" as const, content: `问题 ${index}`, timestamp: index + 1 }
				: {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: `回答 ${index}` }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-4.1",
						usage,
						stopReason: "stop" as const,
						timestamp: index + 1,
					},
		);
		let streamingMessage = {
			role: "assistant" as const,
			content: [{ type: "thinking" as const, thinking: "长历史下的实时思考" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1",
			usage,
			stopReason: "stop" as const,
			timestamp: 1000,
		};
		let view = createView({
			session: { isRunning: true, messages: [...history, streamingMessage] },
			live: {
				streamingMessageId: "assistant:1000",
				streamingMessage,
			},
		});
		let listener: (() => void) | undefined;
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createActions(),
			capabilities: createCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (nextListener: () => void) => {
				listener = nextListener;
				return () => {};
			},
		});

		(mode as unknown as { renderFromState: () => void }).renderFromState();
		const renderMessagesSpy = vi.spyOn(
			mode as unknown as { renderMessages: (nextView: RemoteInteractiveView) => void },
			"renderMessages",
		);
		(mode as unknown as { subscribeToState: () => void }).subscribeToState();
		streamingMessage = {
			...streamingMessage,
			content: [{ type: "thinking" as const, thinking: "长历史下的实时思考更新" }],
		};
		view = createView({
			session: { isRunning: true, messages: [...history, streamingMessage] },
			live: {
				streamingMessageId: "assistant:1000",
				streamingMessage,
			},
		});

		listener?.();

		expect(renderMessagesSpy).not.toHaveBeenCalled();
	});
});
