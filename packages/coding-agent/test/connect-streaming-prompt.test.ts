import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStateSnapshot } from "../src/core/agent-session-proxy.ts";
import { LocalAgentSessionProxy } from "../src/core/local-agent-session-proxy.ts";
import { RemoteAgentSessionProxy } from "../src/modes/connect/remote-agent-session-proxy.ts";

const emptySnapshot: SessionStateSnapshot = {
	model: "test/model",
	thinkingLevel: "off",
	isStreaming: true,
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
};

describe("remote streaming input", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("posts steer input through prompt with steering behavior", () => {
		const requests: Array<{ url: string; body: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}),
		);

		const proxy = new RemoteAgentSessionProxy("http://remote", emptySnapshot);

		proxy.steer("next message");

		expect(requests).toEqual([
			{
				url: "http://remote/prompt",
				body: { text: "next message", options: { streamingBehavior: "steer" } },
			},
		]);
	});

	it("posts follow-up input through prompt with follow-up behavior", () => {
		const requests: Array<{ url: string; body: unknown }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}),
		);

		const proxy = new RemoteAgentSessionProxy("http://remote", emptySnapshot);

		proxy.followUp("queued message");

		expect(requests).toEqual([
			{
				url: "http://remote/prompt",
				body: { text: "queued message", options: { streamingBehavior: "followUp" } },
			},
		]);
	});

	it("preserves streaming behavior when serve mode delegates prompt to the session", async () => {
		const promptCalls: Array<{ text: string; options: unknown }> = [];
		const proxy = new LocalAgentSessionProxy({
			session: {
				prompt: async (text: string, options: unknown) => {
					promptCalls.push({ text, options });
				},
			},
		} as never);

		await proxy.prompt("server-side queued message", { streamingBehavior: "followUp" });

		expect(promptCalls).toEqual([
			{
				text: "server-side queued message",
				options: { images: undefined, streamingBehavior: "followUp" },
			},
		]);
	});
});
