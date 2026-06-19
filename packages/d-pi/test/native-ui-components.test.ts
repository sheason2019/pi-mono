import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { DPiInteractiveSessionStateSnapshot } from "../src/tui/interactive/agent-session-proxy.ts";
import { buildDPiInteractiveMessageListComponent } from "../src/tui/interactive/message-list-view.ts";
import { DPiNativeAssistantMessageComponent } from "../src/tui/native/components/assistant-message.ts";
import { DPiNativeDynamicBorder } from "../src/tui/native/components/dynamic-border.ts";
import { DPiNativeUserMessageComponent } from "../src/tui/native/components/user-message.ts";
import { createDPiNativeTheme, getDPiNativeMarkdownTheme } from "../src/tui/native/theme/theme.ts";

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "thinking trace" },
		{ type: "text", text: "Hello from assistant" },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4",
	stopReason: "stop",
	usage: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 2,
};

function snapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "claude-sonnet-4",
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		steeringMessages: [],
		followUpMessages: [],
		sessionFile: undefined,
		sessionName: undefined,
		messages: [{ role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 1 }, assistantMessage],
		banner: undefined,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
		contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
		modelInfo: { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 200000 },
		autoCompactEnabled: true,
		cwd: "/tmp",
		availableProviderCount: 1,
		remoteSettings: {
			autoCompact: true,
			thinkingLevel: "high",
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

describe("d-pi native interactive components", () => {
	// Parity marker: message-rendering:native-message-components
	it("ports upstream user message, assistant message, and dynamic border rendering", () => {
		const theme = createDPiNativeTheme({ color: true, colorMode: "truecolor" });
		const markdownTheme = getDPiNativeMarkdownTheme(theme);
		const user = new DPiNativeUserMessageComponent("Hi", { theme, markdownTheme });
		const assistant = new DPiNativeAssistantMessageComponent(assistantMessage, { theme, markdownTheme });
		const border = new DPiNativeDynamicBorder((text) => theme.fg("warning", text));

		expect(user.render(24).join("\n")).toContain("\x1b]133;A\x07\x1b[48;2;52;53;65m");
		expect(assistant.render(80).join("\n")).toContain("Hello from assistant");
		expect(assistant.render(80).join("\n")).toContain("\x1b]133;A\x07");
		expect(border.render(5)).toEqual(["\x1b[38;2;255;255;0m─────\x1b[39m"]);
	});

	it("builds the message list from native message components instead of hand-written text blocks", () => {
		const component = buildDPiInteractiveMessageListComponent(snapshot(), {
			color: true,
			colorMode: "truecolor",
		});

		expect(component.children[0]).toBeInstanceOf(DPiNativeUserMessageComponent);
		expect(component.children[1]).toBeInstanceOf(DPiNativeAssistantMessageComponent);
	});

	it("matches upstream addMessageToChat spacing before user messages after prior content", () => {
		const state = {
			...snapshot(),
			messages: [
				{ role: "user" as const, content: [{ type: "text" as const, text: "First" }], timestamp: 1 },
				assistantMessage,
				{ role: "user" as const, content: [{ type: "text" as const, text: "Second" }], timestamp: 3 },
			],
		};
		const component = buildDPiInteractiveMessageListComponent(state);

		expect(component.children[0]).toBeInstanceOf(DPiNativeUserMessageComponent);
		expect(component.children[1]).toBeInstanceOf(DPiNativeAssistantMessageComponent);
		expect(component.children[2]).toBeInstanceOf(Spacer);
		expect(component.children[3]).toBeInstanceOf(DPiNativeUserMessageComponent);
	});

	it("appends turn stats to the native chat stream instead of the separate working-status container", () => {
		const component = buildDPiInteractiveMessageListComponent(snapshot(), {
			statusEntries: [{ afterMessageCount: 2, text: "TPS 10.0 tok/s, out 1, in 2, total 3, 0.1s" }],
		});

		expect(component.children[2]).toBeInstanceOf(Spacer);
		expect(component.children[3]).toBeInstanceOf(Text);
		expect(component.render(80).join("\n")).toContain("TPS 10.0 tok/s");
	});

	it("keeps turn stats attached to the assistant turn they were produced for", () => {
		const state = {
			...snapshot(),
			messages: [
				{ role: "user" as const, content: [{ type: "text" as const, text: "First" }], timestamp: 1 },
				assistantMessage,
				{ role: "user" as const, content: [{ type: "text" as const, text: "Second" }], timestamp: 3 },
			],
		};
		const component = buildDPiInteractiveMessageListComponent(state, {
			statusEntries: [{ afterMessageCount: 2, text: "TPS first turn" }],
		});

		expect(component.children[0]).toBeInstanceOf(DPiNativeUserMessageComponent);
		expect(component.children[1]).toBeInstanceOf(DPiNativeAssistantMessageComponent);
		expect(component.children[2]).toBeInstanceOf(Spacer);
		expect(component.children[3]).toBeInstanceOf(Text);
		expect(component.children[4]).toBeInstanceOf(Spacer);
		expect(component.children[5]).toBeInstanceOf(DPiNativeUserMessageComponent);
		expect(component.render(80).join("\n")).toContain("TPS first turn");
	});
});
