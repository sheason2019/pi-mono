import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStateSnapshot } from "../src/core/agent-session-proxy.ts";
import type { ConnectAuthHeaders } from "../src/modes/connect/auth-headers.ts";
import { loadRemoteClientExtensions } from "../src/modes/connect/client-extension-sync.ts";
import { runConnectMode } from "../src/modes/connect/connect-mode.ts";

vi.mock("../src/modes/interactive/interactive-mode.ts", () => ({
	InteractiveMode: class {
		setProxy(): void {}

		showStatus(): void {}

		async shutdown(): Promise<void> {}

		async run(): Promise<void> {}
	},
}));

vi.mock("../src/modes/connect/remote-agent-session-proxy.ts", () => ({
	RemoteAgentSessionProxy: class {
		readonly headers: ConnectAuthHeaders;

		constructor(
			_url: string,
			_snapshot: SessionStateSnapshot,
			_onDisconnect: unknown,
			options: { headers: ConnectAuthHeaders },
		) {
			this.headers = options.headers;
		}

		async connect(): Promise<void> {}
	},
}));

vi.mock("../src/core/extensions/loader.ts", () => ({
	loadExtensions: () => Promise.resolve({ extensions: [], errors: [], runtime: {} }),
}));

const snapshot = {
	model: "test/model",
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	isBashRunning: false,
	steeringMessages: [],
	followUpMessages: [],
	sessionFile: undefined,
	sessionName: undefined,
	messages: [],
	banner: undefined,
	tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
	contextUsage: { tokens: 0, contextWindow: 1, percent: 0 },
	modelInfo: { id: "test/model", provider: "test", reasoning: false, contextWindow: 1 },
	autoCompactEnabled: false,
	cwd: "/tmp",
	availableProviderCount: 1,
	remoteSettings: {
		autoCompact: false,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		steeringMode: "all",
		followUpMode: "all",
		enableSkillCommands: false,
		doubleEscapeAction: "none",
		showImages: false,
		imageWidthCells: 80,
		autoResizeImages: false,
		blockImages: false,
		transport: "http",
		httpIdleTimeoutMs: 0,
		currentTheme: "dark",
		availableThemes: [],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: false,
		treeFilterMode: "all",
		showHardwareCursor: false,
		editorPaddingX: 0,
		autocompleteMaxVisible: 8,
		quietStartup: false,
		clearOnShrink: true,
		showTerminalProgress: false,
		warnings: {},
	},
	scopedModelIds: null,
	enabledModelPatterns: undefined,
	extensionPaths: [],
} satisfies SessionStateSnapshot;

describe("connect auth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("passes authorization headers to state fetches and remote proxy", async () => {
		const seenAuthHeaders: Array<string | null> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
				seenAuthHeaders.push(new Headers(init?.headers).get("Authorization"));
				return new Response(JSON.stringify(snapshot), { status: 200 });
			}),
		);

		await runConnectMode({ url: "http://remote", authToken: "session-token" });

		expect(seenAuthHeaders).toEqual(["Bearer session-token"]);
	});

	it("passes authorization headers when loading remote client extensions", async () => {
		const seenAuthHeaders: Array<string | null> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
				seenAuthHeaders.push(new Headers(init?.headers).get("Authorization"));
				return new Response(JSON.stringify([]), { status: 200 });
			}),
		);

		await loadRemoteClientExtensions("http://remote", "/tmp", { Authorization: "Bearer session-token" });

		expect(seenAuthHeaders).toEqual(["Bearer session-token"]);
	});
});
