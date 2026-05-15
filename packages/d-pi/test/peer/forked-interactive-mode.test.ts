import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal, resetCapabilitiesCache, setCapabilities } from "@sheason/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSkillInfo, McpRuntimeStatus, SourceRuntimeStatus } from "../../src/hub/index.js";
import { initTheme } from "../../src/peer/tui/components/index.js";
import { RemoteSourceDetailSelectorComponent } from "../../src/peer/tui/forked/components/source-detail-selector.js";
import { ForkedInteractiveMode } from "../../src/peer/tui/forked/interactive-mode.js";
import type { RemoteInteractiveActions } from "../../src/peer/tui/interactive/remote-interactive-actions.js";
import type { RemoteInteractiveCapabilities } from "../../src/peer/tui/interactive/remote-interactive-capabilities.js";
import type { RemoteInteractiveView } from "../../src/peer/tui/interactive/remote-interactive-view.js";

/** 1x1 transparent PNG (valid base64 for Image / kitty preview path). */
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function createRemoteActions(overrides: Partial<RemoteInteractiveActions> = {}): RemoteInteractiveActions {
	return {
		submitPrompt: vi.fn(async () => {}),
		submitFollowUp: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		switchAgent: vi.fn(async () => {}),
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
		...overrides,
	};
}

function createRemoteCapabilities(): RemoteInteractiveCapabilities {
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

function createTimingView(
	sessionOverrides: Partial<NonNullable<RemoteInteractiveView["session"]>> & {
		messages?: Array<
			NonNullable<RemoteInteractiveView["session"]>["items"][number] extends infer Item
				? Item extends { type: "message"; message: infer Message }
					? Message
					: never
				: never
		>;
		runTimings?: Array<
			NonNullable<RemoteInteractiveView["session"]>["items"][number] extends infer Item
				? Item extends { type: "run_timing"; timing: infer Timing }
					? Timing
					: never
				: never
		>;
	},
): RemoteInteractiveView {
	const { messages, runTimings, ...overrides } = sessionOverrides;
	const sessionMessages = messages ?? [{ role: "user" as const, content: "hello", timestamp: 1 }];
	const fallbackTiming =
		overrides.lastRunDurationMs === undefined
			? undefined
			: {
					startedAt: overrides.lastRunStartedAt ?? "",
					endedAt: overrides.lastRunEndedAt ?? "",
					durationMs: overrides.lastRunDurationMs,
					endReason: overrides.lastRunEndReason ?? "completed",
				};
	const timingItems = runTimings ?? (fallbackTiming ? [fallbackTiming] : []);
	const items = createTestItems(sessionMessages, timingItems);
	if (fallbackTiming && !items.some((item) => item.type === "run_timing" && item.timing === fallbackTiming)) {
		items.push({ type: "run_timing", timing: fallbackTiming });
	}
	return {
		connection: { state: "connected", message: "Connected" },
		peers: [],
		session: {
			header: {
				type: "session",
				id: "session-timing",
				timestamp: "2026-04-24T00:00:00.000Z",
				version: 3,
				cwd: "/tmp/workspace",
			},
			sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
			items,
			availableModels: [],
			availableThinkingLevels: [],
			isRunning: false,
			pendingToolCallIds: [],
			queuedMessages: [],
			model: null,
			thinkingLevel: "off",
			diagnostics: [],
			...overrides,
		},
		footer: {
			cwd: "/tmp/workspace",
			modelLabel: "no-model",
			queueSummary: "queued 0",
			pendingToolCount: 0,
			peerCount: 0,
			isRunning: overrides.isRunning ?? false,
			peerId: "peer-a",
			boundAgentId: "main",
		},
		status: { diagnostics: [] },
		commands: [],
	};
}

function createTestItems(
	messages: NonNullable<Parameters<typeof createTimingView>[0]["messages"]>,
	runTimings: NonNullable<Parameters<typeof createTimingView>[0]["runTimings"]>,
): NonNullable<RemoteInteractiveView["session"]>["items"] {
	const items: NonNullable<RemoteInteractiveView["session"]>["items"] = messages.map((message) => ({
		type: "message" as const,
		message,
	}));
	const inserts: Array<{ index: number; timingIndex: number }> = [];
	for (let timingIndex = 0; timingIndex < runTimings.length; timingIndex += 1) {
		const timing = runTimings[timingIndex]!;
		const insertIndex = findTimingInsertIndex(messages, timing);
		if (insertIndex === undefined) {
			continue;
		}
		inserts.push({ index: insertIndex + 1, timingIndex });
	}
	for (const insert of inserts.sort((a, b) => b.index - a.index)) {
		items.splice(insert.index, 0, { type: "run_timing", timing: runTimings[insert.timingIndex]! });
	}
	for (let timingIndex = 0; timingIndex < runTimings.length; timingIndex += 1) {
		if (
			!inserts.some((insert) => insert.timingIndex === timingIndex) &&
			!runTimings[timingIndex]?.startedAt &&
			!runTimings[timingIndex]?.endedAt
		) {
			items.push({ type: "run_timing", timing: runTimings[timingIndex]! });
		}
	}
	return items;
}

function findTimingInsertIndex(
	messages: NonNullable<Parameters<typeof createTimingView>[0]["messages"]>,
	timing: NonNullable<Parameters<typeof createTimingView>[0]["runTimings"]>[number],
): number | undefined {
	const startedAtMs = Date.parse(timing.startedAt);
	const endedAtMs = Date.parse(timing.endedAt);
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
		return undefined;
	}
	let assistantIndex: number | undefined;
	let fallbackIndex: number | undefined;
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i]!;
		const rawTimestamp = "timestamp" in message ? message.timestamp : undefined;
		const timestampMs =
			typeof rawTimestamp === "number"
				? rawTimestamp
				: typeof rawTimestamp === "string"
					? Date.parse(rawTimestamp)
					: NaN;
		if (!Number.isFinite(timestampMs) || timestampMs < startedAtMs - 1000 || timestampMs > endedAtMs + 1000) {
			continue;
		}
		if (message.role === "assistant") {
			assistantIndex = i;
			continue;
		}
		fallbackIndex = i;
	}
	return assistantIndex ?? fallbackIndex;
}

describe("forked interactive mode", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		initTheme();
	});

	it("constructs with remote adapters instead of peer runtime", () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const actions: RemoteInteractiveActions = {
			submitPrompt: vi.fn(async () => {}),
			submitFollowUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			switchAgent: vi.fn(async () => {}),
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
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};

		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		expect(mode).toBeTruthy();
	});

	it("opens an agent selector via /agents and switches to the selected agent", async () => {
		const switchAgent = vi.fn(async (_agentId: string) => {});
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			welcome: {
				sessionId: "s-root",
				peerId: "peer-a",
				agentId: "root",
				clientKind: "peer",
				hubVersion: "0",
				protocolVersion: 4,
				toolNames: [],
				identity: {
					id: "root-token",
					name: "root",
					description: "root token",
					user: "test",
					purpose: "test",
					scopeRootAgentId: "root",
					createdByAgentId: "root",
					root: true,
				},
				scopeRootAgentId: "root",
			},
			agents: [
				{ id: "root", isRunning: false, messageCount: 1, model: { provider: "openai", modelId: "gpt-4.1" } },
				{
					id: "child-a",
					name: "Child A",
					parentId: "root",
					isRunning: true,
					messageCount: 2,
					model: { provider: "anthropic", modelId: "claude-sonnet-4" },
				},
			],
			peers: [],
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 0, steering 0",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: false,
				peerId: "peer-a",
				boundAgentId: "root",
			},
			status: { diagnostics: [] },
			commands: [],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions({ switchAgent }),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_agents" });
		expect((mode as any).activeSelectorKind).toBe("agent-list");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteAgentSelectorComponent");
		const selectorText = stripAnsi((mode as any).activeSelector.render(100).join("\n"));
		expect(selectorText).toContain("openai/gpt-4.1");
		expect(selectorText).toContain("anthropic/claude-sonnet-4");

		(mode as any).activeSelector?.handleInput("\x1b[B");
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(switchAgent).toHaveBeenCalledWith("child-a");
		expect((mode as any).activeSelectorKind).toBeUndefined();
	});

	it("refreshes an open agent selector when agent run states change", async () => {
		let view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			agents: [
				{ id: "root", isRunning: false, messageCount: 1, model: { provider: "openai", modelId: "gpt-4.1" } },
				{
					id: "child-a",
					name: "Child A",
					parentId: "root",
					isRunning: false,
					messageCount: 2,
					model: { provider: "anthropic", modelId: "claude-sonnet-4" },
				},
			],
			peers: [],
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 0, steering 0",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: false,
				peerId: "peer-a",
				boundAgentId: "root",
			},
			status: { diagnostics: [] },
			commands: [],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_agents" });
		expect(stripAnsi((mode as any).activeSelector.render(80).join("\n"))).toMatch(/child-a \(Child A\).*idle/);

		view = {
			...view,
			agents: [
				{ id: "root", isRunning: false, messageCount: 1, model: { provider: "openai", modelId: "gpt-4.1" } },
				{
					id: "child-a",
					name: "Child A",
					parentId: "root",
					isRunning: true,
					messageCount: 2,
					model: { provider: "anthropic", modelId: "claude-sonnet-4.5" },
				},
			],
		};
		(mode as any).renderFromState();

		const selectorText = stripAnsi((mode as any).activeSelector.render(80).join("\n"));
		expect(selectorText).toMatch(/child-a \(Child A\).*working/);
		expect(selectorText).toContain("anthropic/claude-sonnet-4.5");
	});

	it("renders hub-provided working elapsed time in the status area", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_037_000);
		const view = createTimingView({
			isRunning: true,
			runStartedAt: new Date(1_700_000_000_000).toISOString(),
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const lines = (mode as unknown as { statusContainer: { render(w: number): string[] } }).statusContainer.render(
			120,
		);
		expect(stripAnsi(lines.join("\n"))).toContain("Working 00m37s...");
	});

	it("renders completed and interrupted run duration inside the conversation stream", () => {
		const completedView = createTimingView({
			lastRunEndedAt: "2026-04-24T00:02:12.000Z",
			lastRunDurationMs: 102_000,
			lastRunEndReason: "completed",
		});
		const completedMode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => completedView,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});
		(completedMode as unknown as { renderFromState(): void }).renderFromState();
		(completedMode as unknown as { renderFromState(): void }).renderFromState();
		const completedLines = (
			completedMode as unknown as { chatContainer: { render(w: number): string[] } }
		).chatContainer.render(120);
		const completedText = stripAnsi(completedLines.join("\n"));
		expect(completedText.match(/本轮用时: 01m42s/g)).toHaveLength(1);

		const interruptedView = createTimingView({
			messages: [{ role: "user", content: "hello", timestamp: Date.parse("2026-04-24T00:00:36.000Z") }],
			lastRunEndedAt: "2026-04-24T00:00:37.000Z",
			lastRunDurationMs: 37_000,
			lastRunEndReason: "interrupted",
		});
		const interruptedMode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => interruptedView,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});
		(interruptedMode as unknown as { renderFromState(): void }).renderFromState();
		const interruptedLines = (
			interruptedMode as unknown as { chatContainer: { render(w: number): string[] } }
		).chatContainer.render(120);
		expect(stripAnsi(interruptedLines.join("\n"))).toContain("本轮用时: 00m37s（已中断）");
	});

	it("renders run duration next to the assistant message that ended that run", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "first prompt", timestamp: Date.parse("2026-04-24T00:00:01.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "first answer" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:03.000Z"),
				},
				{ role: "user", content: "second prompt", timestamp: Date.parse("2026-04-24T00:00:05.000Z") },
			],
			lastRunStartedAt: "2026-04-24T00:00:01.000Z",
			lastRunEndedAt: "2026-04-24T00:00:03.000Z",
			lastRunDurationMs: 2_000,
			lastRunEndReason: "completed",
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const lines = (mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120);
		const text = stripAnsi(lines.join("\n"));
		const firstAnswerIndex = text.indexOf("first answer");
		const durationIndex = text.indexOf("本轮用时: 00m02s");
		const secondPromptIndex = text.indexOf("second prompt");

		expect(firstAnswerIndex).toBeGreaterThanOrEqual(0);
		expect(durationIndex).toBeGreaterThan(firstAnswerIndex);
		expect(durationIndex).toBeLessThan(secondPromptIndex);
	});

	it("renders run duration without assistant token usage", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "prompt", timestamp: Date.parse("2026-04-24T00:00:01.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "answer with usage" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 1200,
						output: 300,
						cacheRead: 50,
						cacheWrite: 25,
						totalTokens: 1575,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:03.000Z"),
				},
				{ role: "user", content: "next prompt", timestamp: Date.parse("2026-04-24T00:00:05.000Z") },
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:01.000Z",
					endedAt: "2026-04-24T00:00:03.000Z",
					durationMs: 2_000,
					endReason: "completed",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);
		const answerIndex = text.indexOf("answer with usage");
		const durationIndex = text.indexOf("本轮用时: 00m02s");
		const nextPromptIndex = text.indexOf("next prompt");

		expect(durationIndex).toBeGreaterThan(answerIndex);
		expect(durationIndex).toBeLessThan(nextPromptIndex);
		expect(text.match(/本轮用时:/g)).toHaveLength(1);
		expect(text).not.toContain("↑");
		expect(text).not.toContain("↓");
		expect(text).not.toContain("R50");
		expect(text).not.toContain("$0.0123");
	});

	it("does not render assistant token usage for a turn with tool-call and final assistant messages", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "prompt", timestamp: Date.parse("2026-04-24T00:00:01.000Z") },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 165,
						output: 83,
						cacheRead: 1700,
						cacheWrite: 0,
						totalTokens: 1948,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.parse("2026-04-24T00:00:02.000Z"),
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "/tmp/workspace" }],
					isError: false,
					timestamp: Date.parse("2026-04-24T00:00:03.000Z"),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 1200,
						output: 157,
						cacheRead: 167_000,
						cacheWrite: 0,
						totalTokens: 168_357,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:05.000Z"),
				},
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:01.000Z",
					endedAt: "2026-04-24T00:00:05.000Z",
					durationMs: 4_000,
					endReason: "completed",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);

		expect(text).toContain("本轮用时: 00m04s");
		expect(text).not.toContain("↑165 ↓83 R1.7k");
		expect(text).not.toContain("↑1.2k ↓157 R167k");
		expect(text).not.toContain("↑");
	});

	it("updates the live assistant metrics duration while the run is active", () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-24T00:00:06.000Z"));
		const view = createTimingView({
			isRunning: true,
			runStartedAt: "2026-04-24T00:00:01.000Z",
			messages: [{ role: "user", content: "prompt", timestamp: Date.parse("2026-04-24T00:00:01.000Z") }],
		});
		view.live = {
			streamingMessageId: "live-assistant-1",
			streamingMessage: {
				role: "assistant",
				content: [{ type: "text", text: "streaming answer" }],
				api: "openai-completions",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.parse("2026-04-24T00:00:02.000Z"),
			},
			toolExecutions: [],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const firstText = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);
		expect(firstText).toContain("本轮用时: 00m05s");
		expect(firstText).not.toContain("↑1.0k ↓200");

		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-24T00:00:07.000Z"));
		(mode as unknown as { updateWorkingStatusMessage(): void }).updateWorkingStatusMessage();
		const secondText = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);
		expect(secondText).toContain("本轮用时: 00m06s");
		expect(secondText).not.toContain("↑1.0k ↓200");
	});

	it("does not render completed orphan live tools at the bottom of the chat", () => {
		const view = createTimingView({
			isRunning: false,
			messages: [],
		});
		view.live = {
			toolExecutions: [
				{
					toolCallId: "orphan-tool-1",
					toolName: "bash",
					args: { command: "pwd" },
					result: { content: [{ type: "text", text: "/tmp/workspace" }], details: undefined },
					isError: false,
				},
			],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);

		expect(text).toContain("Session is ready");
		expect(text).not.toContain("bash");
		expect(text).not.toContain("pwd");
		expect(text).not.toContain("/tmp/workspace");
	});

	it("renders every persisted run duration after its matching assistant message", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "first prompt", timestamp: Date.parse("2026-04-24T00:00:01.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "first answer" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:03.000Z"),
				},
				{ role: "user", content: "second prompt", timestamp: Date.parse("2026-04-24T00:00:10.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "second answer" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "aborted",
					timestamp: Date.parse("2026-04-24T00:00:14.000Z"),
				},
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:01.000Z",
					endedAt: "2026-04-24T00:00:03.000Z",
					durationMs: 2_000,
					endReason: "completed",
				},
				{
					startedAt: "2026-04-24T00:00:10.000Z",
					endedAt: "2026-04-24T00:00:14.000Z",
					durationMs: 4_000,
					endReason: "interrupted",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const lines = (mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120);
		const text = stripAnsi(lines.join("\n"));
		const firstAnswerIndex = text.indexOf("first answer");
		const firstDurationIndex = text.indexOf("本轮用时: 00m02s");
		const secondPromptIndex = text.indexOf("second prompt");
		const secondAnswerIndex = text.indexOf("second answer");
		const secondDurationIndex = text.indexOf("本轮用时: 00m04s（已中断）");

		expect(firstDurationIndex).toBeGreaterThan(firstAnswerIndex);
		expect(firstDurationIndex).toBeLessThan(secondPromptIndex);
		expect(secondDurationIndex).toBeGreaterThan(secondAnswerIndex);
		expect(text.match(/本轮用时:/g)).toHaveLength(2);
	});

	it("renders run timing timeline items without timestamp matching", () => {
		const userMessage = { role: "user" as const, content: "prompt without timestamp" };
		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "answer without timestamp" }],
			api: "openai-completions",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
		};
		const nextMessage = { role: "user" as const, content: "next prompt without timestamp" };
		const view = createTimingView({
			messages: [userMessage, assistantMessage, nextMessage],
			items: [
				{ type: "message", message: userMessage },
				{ type: "message", message: assistantMessage },
				{
					type: "run_timing",
					timing: {
						startedAt: "2026-04-24T00:00:01.000Z",
						endedAt: "2026-04-24T00:00:04.000Z",
						durationMs: 3_000,
						endReason: "completed",
					},
				},
				{ type: "message", message: nextMessage },
			],
		} as Partial<NonNullable<RemoteInteractiveView["session"]>>);
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);
		const answerIndex = text.indexOf("answer without timestamp");
		const durationIndex = text.indexOf("本轮用时: 00m03s");
		const nextPromptIndex = text.indexOf("next prompt without timestamp");

		expect(durationIndex).toBeGreaterThan(answerIndex);
		expect(durationIndex).toBeLessThan(nextPromptIndex);
		expect(text.match(/本轮用时:/g)).toHaveLength(1);
	});

	it("keeps completed run durations visible while the next run is working", () => {
		const view = createTimingView({
			isRunning: true,
			runStartedAt: "2026-04-24T00:00:10.000Z",
			messages: [
				{ role: "user", content: "interrupted prompt", timestamp: Date.parse("2026-04-24T00:00:01.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "Operation aborted" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "aborted",
					timestamp: Date.parse("2026-04-24T00:00:03.000Z"),
				},
				{ role: "user", content: "flushed prompt", timestamp: Date.parse("2026-04-24T00:00:10.000Z") },
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:01.000Z",
					endedAt: "2026-04-24T00:00:03.000Z",
					durationMs: 2_000,
					endReason: "interrupted",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);
		const abortedIndex = text.indexOf("Operation aborted");
		const durationIndex = text.indexOf("本轮用时: 00m02s（已中断）");
		const flushedPromptIndex = text.indexOf("flushed prompt");

		expect(durationIndex).toBeGreaterThan(abortedIndex);
		expect(durationIndex).toBeLessThan(flushedPromptIndex);
	});

	it("places a completed flush duration after the response instead of the previous abort marker", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "interrupted prompt", timestamp: Date.parse("2026-04-24T00:00:00.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "Operation aborted" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "aborted",
					timestamp: Date.parse("2026-04-24T00:00:04.000Z"),
				},
				{ role: "user", content: "flushed prompt 1", timestamp: Date.parse("2026-04-24T00:00:05.000Z") },
				{ role: "user", content: "flushed prompt 2", timestamp: Date.parse("2026-04-24T00:00:06.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "flush response" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:20.000Z"),
				},
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:00.000Z",
					endedAt: "2026-04-24T00:00:04.000Z",
					durationMs: 4_000,
					endReason: "interrupted",
				},
				{
					startedAt: "2026-04-24T00:00:05.000Z",
					endedAt: "2026-04-24T00:00:20.000Z",
					durationMs: 15_000,
					endReason: "completed",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);
		const abortedIndex = text.indexOf("Operation aborted");
		const interruptedDurationIndex = text.indexOf("本轮用时: 00m04s（已中断）");
		const completedDurationIndex = text.indexOf("本轮用时: 00m15s");
		const responseIndex = text.indexOf("flush response");
		const firstFlushedPromptIndex = text.indexOf("flushed prompt 1");

		expect(interruptedDurationIndex).toBeGreaterThan(abortedIndex);
		expect(interruptedDurationIndex).toBeLessThan(firstFlushedPromptIndex);
		expect(completedDurationIndex).toBeGreaterThan(responseIndex);
		expect(text.match(/本轮用时:/g)).toHaveLength(2);
	});

	it("does not pin unanchored interrupted durations to later normal messages", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "normal prompt", timestamp: Date.parse("2026-04-24T00:00:20.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "normal response" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:35.000Z"),
				},
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:00.000Z",
					endedAt: "2026-04-24T00:00:15.000Z",
					durationMs: 15_000,
					endReason: "interrupted",
				},
				{
					startedAt: "2026-04-24T00:00:20.000Z",
					endedAt: "2026-04-24T00:00:35.000Z",
					durationMs: 15_000,
					endReason: "completed",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);

		expect(text).not.toContain("本轮用时: 00m15s（已中断）");
		expect(text).toContain("本轮用时: 00m15s");
	});

	it("does not append unanchored completed durations at the end", () => {
		const view = createTimingView({
			messages: [
				{ role: "user", content: "later prompt", timestamp: Date.parse("2026-04-24T00:00:20.000Z") },
				{
					role: "assistant",
					content: [{ type: "text", text: "later response" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse("2026-04-24T00:00:25.000Z"),
				},
			],
			runTimings: [
				{
					startedAt: "2026-04-24T00:00:00.000Z",
					endedAt: "2026-04-24T00:00:06.000Z",
					durationMs: 6_000,
					endReason: "completed",
				},
				{
					startedAt: "2026-04-24T00:00:07.000Z",
					endedAt: "2026-04-24T00:00:12.000Z",
					durationMs: 5_000,
					endReason: "completed",
				},
			],
		});
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: createRemoteActions(),
			capabilities: createRemoteCapabilities(),
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as unknown as { renderFromState(): void }).renderFromState();
		const text = stripAnsi(
			(mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120).join("\n"),
		);

		expect(text).toContain("later response");
		expect(text).not.toContain("本轮用时: 00m06s");
		expect(text).not.toContain("本轮用时: 00m05s");
	});

	it("opens the source list selector via /source using getSessionSources", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const getSessionSources = vi.fn(async () => [
			{
				resourceId: "src-one",
				name: "src-one",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
			{
				resourceId: "src-two",
				name: "src-two",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "error" as const,
				error: "process exited",
			},
		]);
		const actions: RemoteInteractiveActions = {
			submitPrompt: vi.fn(async () => {}),
			submitFollowUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(async () => {}),
			invokeCommand: vi.fn(async () => {}),
			getSessionSources,
			pauseSource: vi.fn(async () => []),
			restartSource: vi.fn(async () => []),
			removeSource: vi.fn(async () => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_sources" });
		expect(getSessionSources).toHaveBeenCalledTimes(1);
		expect((mode as any).activeSelectorKind).toBe("source-list");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteSourceListSelectorComponent");

		(mode as any).activeSelector?.handleInput("\r");
		expect((mode as any).activeSelectorKind).toBe("source-detail");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("SelectList");

		(mode as any).activeSelector?.handleInput("\x1b");
		expect((mode as any).activeSelectorKind).toBe("source-list");

		(mode as any).activeSelector?.handleInput("\x1b");
		expect((mode as any).activeSelectorKind).toBeUndefined();
		expect((mode as any).ui.focusedComponent).toBe((mode as any).editor);
	});

	it("invokes pauseSource/restartSource/removeSource and refreshes the list", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const initialSources = [
			{
				resourceId: "src-one",
				name: "src-one",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
			{
				resourceId: "src-two",
				name: "src-two",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
		];
		const getSessionSources = vi.fn(async () => initialSources);
		const pausedSources = [
			{
				resourceId: "src-one",
				name: "src-one",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "stopped" as const,
			},
			{
				resourceId: "src-two",
				name: "src-two",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
		];
		const pauseSource = vi.fn(async (_name: string) => pausedSources);
		const restartedSources = [
			{
				resourceId: "src-one",
				name: "src-one",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
			{
				name: "src-two",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
		];
		const restartSource = vi.fn(async (_name: string) => restartedSources);
		const removedSources = [
			{
				name: "src-two",
				transport: "stdio" as const,
				agentId: "main" as const,
				origin: "hub" as const,
				status: "running" as const,
			},
		];
		const removeSource = vi.fn(async (_name: string) => removedSources);

		const actions: RemoteInteractiveActions = {
			submitPrompt: vi.fn(async () => {}),
			submitFollowUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(async () => {}),
			invokeCommand: vi.fn(async () => {}),
			getSessionSources,
			pauseSource,
			restartSource,
			removeSource,
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_sources" });
		expect((mode as any).activeSelectorKind).toBe("source-list");
		(mode as any).activeSelector?.handleInput("\r");
		expect((mode as any).activeSelectorKind).toBe("source-detail");

		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(pauseSource).toHaveBeenCalledWith("src-one");
		expect((mode as any).activeSelectorKind).toBe("source-list");
		expect((mode as any).currentSourceStatuses).toEqual(pausedSources);

		(mode as any).activeSelector?.handleInput("\r");
		expect((mode as any).activeSelectorKind).toBe("source-detail");
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(restartSource).toHaveBeenCalledWith("src-one");
		expect((mode as any).activeSelectorKind).toBe("source-list");
		expect((mode as any).currentSourceStatuses).toEqual(restartedSources);

		(mode as any).activeSelector?.handleInput("\r");
		(mode as any).activeSelector?.handleInput("\x1b[B");
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(removeSource).toHaveBeenCalledWith("src-one");
		expect((mode as any).activeSelectorKind).toBe("source-list");
		expect((mode as any).currentSourceStatuses).toEqual(removedSources);
	});

	it("shows source Pause or Restart actions based on runtime status", () => {
		initTheme();
		const baseSource: SourceRuntimeStatus = {
			resourceId: "src-one",
			name: "src-one",
			transport: "stdio",
			agentId: "main",
			origin: "hub",
			status: "running",
		};
		const runningText = stripAnsi(
			new RemoteSourceDetailSelectorComponent(
				baseSource,
				() => {},
				() => {},
			)
				.render(80)
				.join("\n"),
		);
		expect(runningText).toContain("Pause");
		expect(runningText).not.toContain("Restart");

		const stoppedText = stripAnsi(
			new RemoteSourceDetailSelectorComponent(
				{ ...baseSource, status: "stopped" },
				() => {},
				() => {},
			)
				.render(80)
				.join("\n"),
		);
		expect(stoppedText).not.toContain("Pause");
		expect(stoppedText).toContain("Restart");

		const errorText = stripAnsi(
			new RemoteSourceDetailSelectorComponent(
				{ ...baseSource, status: "error", error: "process exited" },
				() => {},
				() => {},
			)
				.render(80)
				.join("\n"),
		);
		expect(errorText).not.toContain("Pause");
		expect(errorText).toContain("Restart");
		expect(errorText).toContain("Remove");
	});

	it("warns and stays in editor when /source has no configured sources", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const getSessionSources = vi.fn(async () => []);
		const actions: RemoteInteractiveActions = {
			submitPrompt: vi.fn(async () => {}),
			submitFollowUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(async () => {}),
			invokeCommand: vi.fn(async () => {}),
			getSessionSources,
			pauseSource: vi.fn(async () => []),
			restartSource: vi.fn(async () => []),
			removeSource: vi.fn(async () => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		const appendSpy = vi.spyOn(ForkedInteractiveMode.prototype as any, "appendInfoMessage");
		await (mode as any).handleParsedCommand({ kind: "show_sources" });
		expect(getSessionSources).toHaveBeenCalledTimes(1);
		expect((mode as any).activeSelectorKind).toBeUndefined();
		expect(appendSpy).toHaveBeenCalledTimes(1);
		const text = String(appendSpy.mock.calls[0]?.[0] ?? "");
		expect(text.toLowerCase()).toContain("no source");
		appendSpy.mockRestore();
	});

	const emptyMcpCap: McpRuntimeStatus["capabilities"] = { tools: [], resources: [], prompts: [] };

	it("/mcp opens the MCP list selector and stores fetched status", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const mcpA = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const getMcpServers = vi.fn(async () => ({ servers: [mcpA] }));
		const actions: RemoteInteractiveActions = {
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
			getMcpServers,
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		expect(getMcpServers).toHaveBeenCalledTimes(1);
		expect((mode as any).activeSelectorKind).toBe("mcp-list");
		expect((mode as any).currentMcpServers).toEqual([mcpA]);
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteMcpListSelectorComponent");
	});

	it("/skills opens the skills selector and stores fetched skills", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const skill: HubSkillInfo = {
			name: "review",
			description: "Review code changes",
			filePath: "/tmp/skills/review/SKILL.md",
			disableModelInvocation: false,
		};
		const getSkills = vi.fn(async () => ({ ok: true as const, skills: [skill], diagnostics: [] }));
		const actions: RemoteInteractiveActions = {
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
			getSkills,
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_skills" });

		expect(getSkills).toHaveBeenCalledTimes(1);
		expect((mode as any).activeSelectorKind).toBe("skill-list");
		expect((mode as any).currentSkills).toEqual([skill]);
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteSkillListSelectorComponent");
	});

	it("/skills opens the selected duplicate skill entry by position", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const firstSkill: HubSkillInfo = {
			name: "review",
			description: "Review from first source",
			filePath: "/tmp/first/review/SKILL.md",
			disableModelInvocation: false,
			sourceInfo: { source: "first" },
		};
		const secondSkill: HubSkillInfo = {
			name: "review",
			description: "Review from second source",
			filePath: "/tmp/second/review/SKILL.md",
			disableModelInvocation: false,
			sourceInfo: { source: "second" },
		};
		const actions: RemoteInteractiveActions = {
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
			getSkills: vi.fn(async () => ({ ok: true as const, skills: [firstSkill, secondSkill], diagnostics: [] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_skills" });
		(mode as any).activeSelector?.handleInput("\x1b[B");
		(mode as any).activeSelector?.handleInput("\r");

		expect((mode as any).activeSelectorKind).toBe("skill-detail");
		const detailText = (mode as any).activeSelector.render(100).join("\n");
		expect(detailText).toContain("/tmp/second/review/SKILL.md");
		expect(detailText).toContain("Review from second source");
	});

	it("shows a warning when /mcp cannot fetch servers", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const getMcpServers = vi.fn(async () => {
			throw new Error("hub mcp list failed");
		});
		const actions: RemoteInteractiveActions = {
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
			getMcpServers,
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		const appendSpy = vi.spyOn(ForkedInteractiveMode.prototype as any, "appendWarningMessage");
		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		expect(getMcpServers).toHaveBeenCalledTimes(1);
		expect((mode as any).activeSelectorKind).toBeUndefined();
		expect(appendSpy).toHaveBeenCalledWith("hub mcp list failed");
		appendSpy.mockRestore();
	});

	it("selecting an MCP server in the list opens the detail for that status", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const mcpA = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const actions: RemoteInteractiveActions = {
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
			getMcpServers: vi.fn(async () => ({ servers: [mcpA] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		expect((mode as any).activeSelectorKind).toBe("mcp-detail");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("SelectList");
		const detailLines = (mode as any).activeSelector
			.render(100)
			.map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, ""));
		expect(detailLines.some((line: string) => line.includes("a") && line.includes("stdio"))).toBe(true);
	});

	it("Esc from MCP detail returns to mcp list selector (does not close)", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const mcpA = {
			resourceId: "mcp-a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const actions: RemoteInteractiveActions = {
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
			getMcpServers: vi.fn(async () => ({ servers: [mcpA] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		(mode as any).activeSelector?.handleInput("\r");
		expect((mode as any).activeSelectorKind).toBe("mcp-detail");
		(mode as any).activeSelector?.handleInput("\x1b");
		expect((mode as any).activeSelectorKind).toBe("mcp-list");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteMcpListSelectorComponent");
	});

	it("pause calls pauseMcpServer and refetches", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const running = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const stopped = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "stopped" as const,
			capabilities: { ...emptyMcpCap },
		};
		const getMcpServers = vi
			.fn()
			.mockResolvedValueOnce({ servers: [running] })
			.mockResolvedValue({ servers: [stopped] });
		const pauseMcpServer = vi.fn(async () => [stopped]);
		const actions: RemoteInteractiveActions = {
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
			getMcpServers,
			pauseMcpServer,
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		(mode as any).activeSelector?.handleInput("\r");
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(pauseMcpServer).toHaveBeenCalledWith("a");
		expect(getMcpServers).toHaveBeenCalledTimes(2);
		expect((mode as any).activeSelectorKind).toBe("mcp-detail");
		expect((mode as any).currentMcpServers).toEqual([stopped]);
	});

	it("restart calls restartMcpServer and refetches", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const stopped = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "stopped" as const,
			capabilities: { ...emptyMcpCap },
		};
		const running = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const getMcpServers = vi
			.fn()
			.mockResolvedValueOnce({ servers: [stopped] })
			.mockResolvedValue({ servers: [running] });
		const restartMcpServer = vi.fn(async () => [running]);
		const actions: RemoteInteractiveActions = {
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
			getMcpServers,
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer,
			removeMcpServer: vi.fn(async () => []),
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		(mode as any).activeSelector?.handleInput("\r");
		(mode as any).activeSelector?.handleInput("\x1b[B");
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(restartMcpServer).toHaveBeenCalledWith("a");
		expect(getMcpServers).toHaveBeenCalledTimes(2);
		expect((mode as any).currentMcpServers).toEqual([running]);
	});

	it("remove calls removeMcpServer, refetches, and returns to the list", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const a = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const b = {
			resourceId: "b",
			name: "b",
			transport: "http" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const getMcpServers = vi
			.fn()
			.mockResolvedValueOnce({ servers: [a, b] })
			.mockResolvedValue({ servers: [b] });
		const removeMcpServer = vi.fn(async () => [b]);
		const actions: RemoteInteractiveActions = {
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
			getMcpServers,
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		(mode as any).activeSelector?.handleInput("\r");
		(mode as any).activeSelector?.handleInput("\x1b[B");
		(mode as any).activeSelector?.handleInput("\x1b[B");
		(mode as any).activeSelector?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(removeMcpServer).toHaveBeenCalledWith("a");
		expect((mode as any).activeSelectorKind).toBe("mcp-list");
		expect((mode as any).currentMcpServers).toEqual([b]);
	});

	it("Esc closes the MCP list selector and restores the editor", async () => {
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected" },
			peers: [],
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
		};
		const a = {
			resourceId: "a",
			name: "a",
			transport: "stdio" as const,
			status: "running" as const,
			capabilities: { ...emptyMcpCap },
		};
		const actions: RemoteInteractiveActions = {
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
			getMcpServers: vi.fn(async () => ({ servers: [a] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_mcp_servers" });
		(mode as any).activeSelector?.handleInput("\x1b");
		expect((mode as any).activeSelectorKind).toBeUndefined();
		expect((mode as any).ui.focusedComponent).toBe((mode as any).editor);
	});

	it("opens remote selectors for /model and /settings summaries", async () => {
		const view: RemoteInteractiveView = {
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
				availableModels: [
					{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true },
					{
						provider: "anthropic",
						modelId: "claude-sonnet-4-20250514",
						label: "Claude Sonnet 4",
						reasoning: true,
					},
				],
				availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
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
			commands: [
				{ name: "model", description: "Inspect or switch the active model" },
				{ name: "settings", description: "Inspect supported peer settings" },
			],
		};
		const actions: RemoteInteractiveActions = {
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
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};

		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).handleParsedCommand({ kind: "show_model" });
		expect((mode as any).activeSelectorKind).toBe("model");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteModelSelectorComponent");

		(mode as any).closeSelector();
		expect((mode as any).activeSelectorKind).toBeUndefined();
		expect((mode as any).ui.focusedComponent).toBe((mode as any).editor);
		await (mode as any).handleParsedCommand({ kind: "show_settings" });
		expect((mode as any).activeSelectorKind).toBe("settings");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("SelectList");
	});

	it("binds app.model.select to the model selector", () => {
		const view: RemoteInteractiveView = {
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
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
			live: { toolExecutions: [] },
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
			commands: [{ name: "model", description: "Inspect or switch the active model" }],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
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
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).editor.actionHandlers.get("app.model.select")?.();

		expect((mode as any).activeSelectorKind).toBe("model");
		expect((mode as any).ui.focusedComponent?.constructor?.name).toBe("RemoteModelSelectorComponent");
	});

	it("moves the model selector pointer with arrow keys", () => {
		const view: RemoteInteractiveView = {
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
				availableModels: [
					{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true },
					{ provider: "anthropic", modelId: "claude-sonnet-4", label: "Claude Sonnet 4", reasoning: true },
				],
				availableThinkingLevels: ["off", "high"],
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
			live: { toolExecutions: [] },
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
			commands: [{ name: "model", description: "Inspect or switch the active model" }],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
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
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).editor.actionHandlers.get("app.model.select")?.();
		(mode as any).ui.focusedComponent?.handleInput("\x1b[B");

		const selectorLines = (mode as any).activeSelector
			.render(100)
			.map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, ""));

		expect(selectorLines.some((line: string) => line.includes("→ claude-sonnet-4"))).toBe(true);
	});

	it("exposes slash command suggestions when typing '/'", async () => {
		const view: RemoteInteractiveView = {
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
				availableModels: [
					{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true },
					{ provider: "anthropic", modelId: "claude-sonnet-4", label: "Claude Sonnet 4", reasoning: true },
				],
				availableThinkingLevels: ["off", "high"],
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
			live: { toolExecutions: [] },
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
			commands: [
				{ name: "model", description: "Inspect or switch the active model" },
				{ name: "settings", description: "Inspect supported peer settings" },
				{ name: "compact", description: "Ask hub to compact the current session" },
			],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
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
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		const provider = (mode as any).editor.autocompleteProvider;
		const suggestions = await provider?.getSuggestions(["/"], 0, 1, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item: { value: string }) => item.value)).toContain("model");
		expect(suggestions?.items.map((item: { value: string }) => item.value)).toContain("settings");
	});

	it("uses ctrl+c twice to exit like native pi", () => {
		vi.useFakeTimers();
		try {
			const view: RemoteInteractiveView = {
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
					availableModels: [],
					availableThinkingLevels: [],
					isRunning: false,
					pendingToolCallIds: [],
					model: { provider: "openai", modelId: "gpt-4.1" },
					thinkingLevel: "high",
					diagnostics: [],
				},
				live: { toolExecutions: [] },
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
			};
			const mode = new ForkedInteractiveMode({
				peerId: "peer-a",
				cwd: "/tmp/workspace",
				getView: () => view,
				actions: {
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
				},
				capabilities: {
					supportsCompact: true,
					supportsReload: true,
					supportsModelSelection: true,
					supportsSessionTree: false,
					supportsSessionCreation: false,
					supportsSessionResume: false,
					supportsSessionFork: false,
					supportsSessionClone: false,
				},
				getDraft: () => "",
				setDraft: (_draft: string) => {},
				subscribe: (_listener: () => void) => () => {},
			});

			const shutdownSpy = vi.fn(async () => {});
			(mode as any).shutdown = shutdownSpy;

			(mode as any).editor.actionHandlers.get("app.clear")?.();
			expect(shutdownSpy).not.toHaveBeenCalled();

			vi.advanceTimersByTime(200);
			(mode as any).editor.actionHandlers.get("app.clear")?.();
			expect(shutdownSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("restores queued messages to the editor with alt+up", async () => {
		const invokeCommand = vi.fn(async () => {});
		const setDraft = vi.fn();
		const view: RemoteInteractiveView = {
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
				availableModels: [],
				availableThinkingLevels: [],
				isRunning: true,
				pendingToolCallIds: [],
				queuedMessages: [
					{ text: "先修正这一段", messageSource: { kind: "peer", name: "peer-a" } },
					{ text: "之后补一句", messageSource: { kind: "source", name: "source-a" } },
					{ text: "最后总结一下", messageSource: { kind: "agent", name: "child-a" } },
				],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
			live: { toolExecutions: [] },
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "queued 3",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: true,
				peerId: "peer-a",
				boundAgentId: "main",
			},
			status: { diagnostics: [] },
			commands: [],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
				submitPrompt: vi.fn(async () => {}),
				submitFollowUp: vi.fn(async () => {}),
				steer: vi.fn(async () => {}),
				abort: vi.fn(async () => {}),
				setModel: vi.fn(async () => {}),
				setThinkingLevel: vi.fn(async () => {}),
				invokeCommand,
				getSessionSources: vi.fn(async () => []),
				pauseSource: vi.fn(async () => []),
				restartSource: vi.fn(async () => []),
				removeSource: vi.fn(async () => []),
				getMcpServers: vi.fn(async () => ({ servers: [] })),
				pauseMcpServer: vi.fn(async () => []),
				restartMcpServer: vi.fn(async () => []),
				removeMcpServer: vi.fn(async () => []),
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft,
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).editor.setText("现有草稿");
		await (mode as any).editor.actionHandlers.get("app.message.dequeue")?.();

		expect(invokeCommand).toHaveBeenCalledWith("dequeue");
		expect((mode as any).editor.getText()).toBe("先修正这一段\n\n之后补一句\n\n最后总结一下\n\n现有草稿");
		expect(setDraft).toHaveBeenCalledWith("先修正这一段\n\n之后补一句\n\n最后总结一下\n\n现有草稿");
	});

	it("stores submitted prompts in local editor history and browses them with up/down", async () => {
		const queueWrite = vi.fn(async () => {});
		const view: RemoteInteractiveView = {
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
				availableModels: [],
				availableThinkingLevels: [],
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
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
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
				queueWrite,
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
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		await (mode as any).queueInput("第一条消息");
		await (mode as any).queueInput("第二条消息");

		(mode as any).editor.handleInput("\x1b[A");
		expect((mode as any).editor.getText()).toBe("第二条消息");
		(mode as any).editor.handleInput("\x1b[A");
		expect((mode as any).editor.getText()).toBe("第一条消息");
		(mode as any).editor.handleInput("\x1b[B");
		expect((mode as any).editor.getText()).toBe("第二条消息");
		(mode as any).editor.handleInput("\x1b[B");
		expect((mode as any).editor.getText()).toBe("");
		expect(queueWrite).toHaveBeenCalledTimes(2);
	});

	it("uses ctrl+j to insert a newline without submitting", () => {
		const submitPrompt = vi.fn(async () => {});
		const view: RemoteInteractiveView = {
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
				availableModels: [],
				availableThinkingLevels: [],
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
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
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
				submitPrompt,
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
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).editor.handleInput("第");
		(mode as any).editor.handleInput("\n");
		(mode as any).editor.handleInput("二行");

		expect((mode as any).editor.getText()).toBe("第\n二行");
		expect(submitPrompt).not.toHaveBeenCalled();
	});

	it("starts tui input loop and submits prompt on Enter", async () => {
		const view: RemoteInteractiveView = {
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
				availableModels: [],
				availableThinkingLevels: [],
				isRunning: false,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
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
		};
		const actions: RemoteInteractiveActions = {
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
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};

		let onInput: ((data: string) => void) | undefined;
		const startSpy = vi.spyOn(ProcessTerminal.prototype, "start").mockImplementation((inputHandler) => {
			onInput = inputHandler;
		});
		vi.spyOn(ProcessTerminal.prototype, "stop").mockImplementation(() => {});
		vi.spyOn(ProcessTerminal.prototype, "drainInput").mockResolvedValue();
		vi.spyOn(ProcessTerminal.prototype, "hideCursor").mockImplementation(() => {});
		vi.spyOn(ProcessTerminal.prototype, "showCursor").mockImplementation(() => {});
		vi.spyOn(ProcessTerminal.prototype, "write").mockImplementation(() => {});
		vi.spyOn(ProcessTerminal.prototype, "setTitle").mockImplementation(() => {});

		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		try {
			const runPromise = mode.run();
			await Promise.resolve();

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(onInput).toBeTypeOf("function");

			onInput?.("介绍一下你自己");
			onInput?.("\r");
			await Promise.resolve();

			expect(actions.submitPrompt).toHaveBeenCalledWith("介绍一下你自己");

			(mode as any).shutdownResolver?.(0);
			await mode.stop();
			await runPromise;
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("renders image protocol output for live tool row when image blocks carry hydrated data and mimeType", () => {
		initTheme("dark");
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const view: RemoteInteractiveView = {
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
				availableModels: [],
				availableThinkingLevels: ["off", "high"],
				isRunning: true,
				pendingToolCallIds: [],
				model: { provider: "openai", modelId: "gpt-4.1" },
				thinkingLevel: "high",
				diagnostics: [],
			},
			live: {
				toolExecutions: [
					{
						toolCallId: "tc-tui-hydrated-1",
						toolName: "read",
						args: { file_path: "/tmp/w.png" },
						result: {
							content: [
								{ type: "text", text: "Read [image/png]" },
								{ type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
							],
							details: undefined,
						},
						isError: false,
					},
				],
			},
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 0, steering 0",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: true,
				peerId: "peer-a",
				boundAgentId: "main",
			},
			status: { diagnostics: [] },
			commands: [],
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions: {
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
			},
			capabilities: {
				supportsCompact: true,
				supportsReload: true,
				supportsModelSelection: true,
				supportsSessionTree: false,
				supportsSessionCreation: false,
				supportsSessionResume: false,
				supportsSessionFork: false,
				supportsSessionClone: false,
			},
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});
		(mode as unknown as { renderFromState(): void }).renderFromState();
		const lines = (mode as unknown as { chatContainer: { render(w: number): string[] } }).chatContainer.render(120);
		const allLines = lines.flatMap((line) => line.split("\n"));
		// Kitty graphics protocol (same prefix ToolExecutionComponent / Image use for previews)
		expect(allLines.some((line) => line.includes("\x1b_G"))).toBe(true);
	});

	it("binds app.connection.retry to retryConnection", () => {
		const view: RemoteInteractiveView = {
			connection: { state: "reconnecting" },
			peers: [],
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 0",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: false,
				peerId: "peer-a",
				boundAgentId: "main",
			},
			status: { connectionMessage: "Connection lost. Retrying in 5s.", diagnostics: [] },
			commands: [],
		};
		const retryConnection = vi.fn(async () => {});
		const actions: RemoteInteractiveActions = {
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
			retryConnection,
		};
		const capabilities: RemoteInteractiveCapabilities = {
			supportsCompact: true,
			supportsReload: true,
			supportsModelSelection: true,
			supportsSessionTree: false,
			supportsSessionCreation: false,
			supportsSessionResume: false,
			supportsSessionFork: false,
			supportsSessionClone: false,
		};
		const mode = new ForkedInteractiveMode({
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			getView: () => view,
			actions,
			capabilities,
			getDraft: () => "",
			setDraft: (_draft: string) => {},
			subscribe: (_listener: () => void) => () => {},
		});

		(mode as any).editor.actionHandlers.get("app.connection.retry")?.();

		expect(retryConnection).toHaveBeenCalledTimes(1);
	});

	it("preserves explicit app.connection.retry disablement from keybindings config", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "d-pi-keybindings-"));
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.connection.retry": [] }), "utf8");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const view: RemoteInteractiveView = {
				connection: { state: "reconnecting" },
				peers: [],
				footer: {
					cwd: "/tmp/workspace",
					modelLabel: "openai/gpt-4.1",
					queueSummary: "follow-up 0",
					pendingToolCount: 0,
					peerCount: 0,
					isRunning: false,
					peerId: "peer-a",
					boundAgentId: "main",
				},
				status: { connectionMessage: "Connection lost. Retrying in 5s.", diagnostics: [] },
				commands: [],
			};
			const mode = new ForkedInteractiveMode({
				peerId: "peer-a",
				cwd: "/tmp/workspace",
				getView: () => view,
				actions: createRemoteActions(),
				capabilities: createRemoteCapabilities(),
				getDraft: () => "",
				setDraft: (_draft: string) => {},
				subscribe: (_listener: () => void) => () => {},
			});

			const keybindings = (mode as unknown as { keybindings: { getKeys(key: "app.connection.retry"): string[] } })
				.keybindings;

			expect(keybindings.getKeys("app.connection.retry")).toEqual([]);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});
