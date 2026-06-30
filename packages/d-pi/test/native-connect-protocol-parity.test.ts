import { describe, expect, it, vi } from "vitest";
import type {
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveSessionStateSnapshot,
} from "../src/tui/interactive/agent-session-proxy.ts";
import {
	DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS,
	DPI_NATIVE_CONNECT_PROTOCOL_QUERIES,
} from "../src/tui/interactive/native-parity-manifest.ts";
import {
	handleDPiInteractiveProtocolQuery,
	handleDPiInteractiveProtocolRequest,
} from "../src/tui/interactive/protocol-core.ts";

function snapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "anthropic/claude-sonnet-4",
		plan: [],
		isStreaming: false,
		isCompacting: false,
		steeringMessages: [],
		sessionFile: "/tmp/session.jsonl",
		sessionName: "session",
		messages: [],
		banner: undefined,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
		contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
		modelInfo: { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 200000 },
		autoCompactEnabled: true,
		cwd: "/tmp/workspace",
		availableProviderCount: 1,
		remoteSettings: {
			showImages: true,
			imageWidthCells: 60,
			autoResizeImages: true,
			blockImages: false,
			httpIdleTimeoutMs: 600000,
			currentTheme: "default",
			availableThemes: ["default"],
			hideThinkingBlock: false,
			collapseChangelog: false,
			enableInstallTelemetry: false,
			showHardwareCursor: false,
			editorPaddingX: 0,
			autocompleteMaxVisible: 10,
			quietStartup: false,
			clearOnShrink: true,
			showTerminalProgress: true,
			warnings: {},
		},
	};
}

function createProxy(): DPiInteractiveAgentSessionProxy {
	const state = snapshot();
	return {
		subscribe: () => () => {},
		prompt: vi.fn(async () => {}),
		steer: vi.fn(),
		followUp: vi.fn(),
		abort: vi.fn(),
		clearQueue: vi.fn(() => ({ steering: [] })),
		compact: vi.fn(async () => {}),
		newSession: vi.fn(async () => {}),
		switchSession: vi.fn(async () => {}),
		renameSession: vi.fn(),
		reload: vi.fn(async () => {}),
		updateSettings: vi.fn(),
		getSessions: vi.fn(async () => []),
		fetchCommands: vi.fn(async () => []),
		fetchModels: vi.fn(async () => []),
		getCommands: vi.fn(() => []),
		getModels: vi.fn(() => []),
		getSnapshot: vi.fn(() => state),
		get model() {
			return state.model;
		},
		get isStreaming() {
			return state.isStreaming;
		},
		get isCompacting() {
			return state.isCompacting;
		},
		get steeringMessages() {
			return state.steeringMessages;
		},
		get sessionFile() {
			return state.sessionFile;
		},
		get sessionName() {
			return state.sessionName;
		},
		get messages() {
			return state.messages;
		},
	};
}

describe("native connect protocol parity", () => {
	it("keeps query and action manifests covered by the protocol dispatcher", async () => {
		const proxy = createProxy();
		for (const query of DPI_NATIVE_CONNECT_PROTOCOL_QUERIES) {
			await expect(handleDPiInteractiveProtocolQuery(proxy, query), query).resolves.toMatchObject({ status: 200 });
		}

		const bodies: Record<string, unknown> = {
			prompt: { text: "hello" },
			steer: { text: "interrupt" },
			"follow-up": { text: "continue" },
			"switch-session": { sessionFile: "/tmp/session.jsonl" },
			name: { name: "session" },
			"scoped-models": { enabledIds: null },
			"enabled-models": { patterns: undefined },
			settings: { autoCompact: true },
		};
		for (const action of DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS) {
			await expect(
				handleDPiInteractiveProtocolRequest(proxy, action, bodies[action] ?? {}),
				action,
			).resolves.toMatchObject({
				status: 200,
			});
		}
	});
});
