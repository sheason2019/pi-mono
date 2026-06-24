import { describe, expect, it, vi } from "vitest";
import type {
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveSessionStateSnapshot,
} from "../src/tui/interactive/agent-session-proxy.ts";
import {
	handleDPiInteractiveProtocolQuery,
	handleDPiInteractiveProtocolRequest,
} from "../src/tui/interactive/protocol-core.ts";

function createSnapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "claude-sonnet-4",
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		steeringMessages: [],
		followUpMessages: [],
		sessionFile: "/tmp/session.jsonl",
		sessionName: "root session",
		messages: [],
		banner: {
			appName: "d-pi",
			version: "0.6.0-alpha.8",
			expandedHints: [{ key: "Ctrl+C", description: "to interrupt" }],
			compactHints: [{ key: "/", description: "for commands" }],
			compactOnboarding: "d-pi coding agent",
			onboarding: "Welcome to d-pi",
			loadedResources: [
				{
					name: "Context",
					compactList: "AGENTS.md",
					expandedList: "AGENTS.md",
				},
			],
			diagnostics: [],
			changelogMarkdown: undefined,
		},
		tokenUsage: {
			input: 1200,
			output: 340,
			cacheRead: 800,
			cacheWrite: 100,
			cost: 0.123,
			usingSubscription: false,
			latestCacheHitRate: 66.7,
		},
		contextUsage: {
			tokens: 2440,
			contextWindow: 200000,
			percent: 1.22,
		},
		modelInfo: {
			id: "claude-sonnet-4",
			provider: "anthropic",
			reasoning: true,
			contextWindow: 200000,
		},
		autoCompactEnabled: true,
		cwd: "/tmp/workspace",
		availableProviderCount: 2,
		remoteSettings: {
			autoCompact: true,
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
			steeringMode: "all",
			followUpMode: "all",
			enableSkillCommands: true,
			doubleEscapeAction: "tree",
			showImages: true,
			imageWidthCells: 60,
			autoResizeImages: true,
			blockImages: false,
			transport: "auto",
			httpIdleTimeoutMs: 600000,
			currentTheme: "default",
			availableThemes: ["default"],
			hideThinkingBlock: false,
			collapseChangelog: false,
			enableInstallTelemetry: false,
			treeFilterMode: "all",
			showHardwareCursor: false,
			editorPaddingX: 0,
			autocompleteMaxVisible: 10,
			quietStartup: false,
			clearOnShrink: true,
			showTerminalProgress: true,
			warnings: {},
		},
		scopedModelIds: null,
		enabledModelPatterns: undefined,
		extensionPaths: [],
	};
}

function createProxy(snapshot: DPiInteractiveSessionStateSnapshot): DPiInteractiveAgentSessionProxy {
	return {
		subscribe: () => () => {},
		prompt: vi.fn(async () => {}),
		steer: vi.fn(),
		followUp: vi.fn(),
		abort: vi.fn(),
		abortBash: vi.fn(),
		clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
		get model() {
			return snapshot.model;
		},
		get thinkingLevel() {
			return snapshot.thinkingLevel;
		},
		get isStreaming() {
			return snapshot.isStreaming;
		},
		get isCompacting() {
			return snapshot.isCompacting;
		},
		get isBashRunning() {
			return snapshot.isBashRunning;
		},
		get steeringMessages() {
			return snapshot.steeringMessages;
		},
		get followUpMessages() {
			return snapshot.followUpMessages;
		},
		get sessionFile() {
			return snapshot.sessionFile;
		},
		get sessionName() {
			return snapshot.sessionName;
		},
		get messages() {
			return snapshot.messages;
		},
		compact: vi.fn(async () => {}),
		setAutoCompactEnabled: vi.fn(),
		setSteeringMode: vi.fn(),
		setFollowUpMode: vi.fn(),
		newSession: vi.fn(async () => {}),
		switchSession: vi.fn(async () => {}),
		fork: vi.fn(async () => {}),
		renameSession: vi.fn(),
		setLabel: vi.fn(),
		reload: vi.fn(async () => {}),
		setScopedModels: vi.fn(),
		setEnabledModels: vi.fn(),
		updateSettings: vi.fn(),
		getTree: vi.fn(() => []),
		getUserMessagesForForking: vi.fn(() => []),
		getSessions: vi.fn(async () => []),
		fetchTree: vi.fn(async () => []),
		fetchUserMessagesForForking: vi.fn(async () => []),
		fetchCommands: vi.fn(async () => [{ name: "agents", source: "builtin" as const }]),
		fetchModels: vi.fn(async () => []),
		fetchClientExtensions: vi.fn(async () => []),
		getCommands: vi.fn(() => [{ name: "agents", source: "builtin" as const }]),
		getModels: vi.fn(() => []),
		getClientExtensions: vi.fn(() => []),
		getSnapshot: vi.fn(() => snapshot),
	};
}

describe("d-pi interactive protocol contract", () => {
	it("returns an interactive-compatible state snapshot with banner and footer data", async () => {
		const snapshot = createSnapshot();
		const proxy = createProxy(snapshot);

		const result = await handleDPiInteractiveProtocolQuery(proxy, "state");

		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({
			model: "claude-sonnet-4",
			banner: { appName: "d-pi", compactOnboarding: "d-pi coding agent" },
			tokenUsage: { input: 1200, cacheRead: 800, latestCacheHitRate: 66.7 },
			contextUsage: { contextWindow: 200000, percent: 1.22 },
			modelInfo: { provider: "anthropic", reasoning: true },
			cwd: "/tmp/workspace",
			availableProviderCount: 2,
		});
	});

	it("routes prompt, steer, and follow-up through the proxy without collapsing them into one action", async () => {
		const proxy = createProxy(createSnapshot());

		await expect(handleDPiInteractiveProtocolRequest(proxy, "prompt", { text: "hello" })).resolves.toMatchObject({
			status: 200,
		});
		await expect(handleDPiInteractiveProtocolRequest(proxy, "steer", { text: "interrupt" })).resolves.toMatchObject({
			status: 200,
		});
		await expect(
			handleDPiInteractiveProtocolRequest(proxy, "follow-up", { text: "continue" }),
		).resolves.toMatchObject({
			status: 200,
		});

		expect(proxy.prompt).toHaveBeenCalledWith("hello", undefined);
		expect(proxy.steer).toHaveBeenCalledWith("interrupt", undefined);
		expect(proxy.followUp).toHaveBeenCalledWith("continue", undefined);
	});

	it("exposes commands through the interactive protocol for connect autocomplete", async () => {
		const proxy = createProxy(createSnapshot());

		const result = await handleDPiInteractiveProtocolQuery(proxy, "commands");

		expect(result).toEqual({
			status: 200,
			body: [{ name: "agents", source: "builtin" }],
		});
	});

	it("uses async connect data queries instead of synchronous empty fallbacks", async () => {
		const snapshot = createSnapshot();
		const proxy = createProxy(snapshot);
		vi.mocked(proxy.fetchTree).mockResolvedValueOnce([
			{ id: "entry-1", type: "user", parentId: null, timestamp: "2026-06-19T00:00:00Z", children: [] },
		]);
		vi.mocked(proxy.fetchUserMessagesForForking).mockResolvedValueOnce([{ id: "entry-1", text: "hello" }]);
		vi.mocked(proxy.fetchClientExtensions).mockResolvedValueOnce([
			{ name: "client-ext", script: "export default {};" },
		]);

		await expect(handleDPiInteractiveProtocolQuery(proxy, "tree")).resolves.toMatchObject({
			body: [{ id: "entry-1" }],
		});
		await expect(handleDPiInteractiveProtocolQuery(proxy, "user-messages")).resolves.toMatchObject({
			body: [{ id: "entry-1", text: "hello" }],
		});
		await expect(handleDPiInteractiveProtocolQuery(proxy, "models")).resolves.toMatchObject({ status: 404 });
		await expect(handleDPiInteractiveProtocolQuery(proxy, "client-extensions")).resolves.toMatchObject({
			body: [{ name: "client-ext", script: "export default {};" }],
		});

		expect(proxy.getTree).not.toHaveBeenCalled();
		expect(proxy.getUserMessagesForForking).not.toHaveBeenCalled();
		expect(proxy.getModels).not.toHaveBeenCalled();
	});
});
