import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { DPiInteractiveSessionStateSnapshot } from "../src/tui/interactive/agent-session-proxy.ts";
import { buildDPiInteractiveMessageListComponent } from "../src/tui/interactive/message-list-view.ts";
import { DPiNativeAssistantMessageComponent } from "../src/tui/native/components/assistant-message.ts";
import { DPiNativeDynamicBorder } from "../src/tui/native/components/dynamic-border.ts";
import { DPiNativeToolExecutionComponent } from "../src/tui/native/components/tool-execution.ts";
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

	it("does not render d-pi meta custom message mirrors as raw plain text", () => {
		const state = {
			...snapshot(),
			messages: [
				{ role: "user" as const, content: "ls 一下", timestamp: 1 },
				{
					role: "custom" as const,
					customType: "d-pi-message",
					content: '[meta({"sourceType":"connect","connectId":"id"})]\nls 一下',
					display: true,
					details: { sourceType: "connect", connectId: "id" },
					timestamp: 2,
				},
			],
		};
		const component = buildDPiInteractiveMessageListComponent(state, { color: true, colorMode: "truecolor" });
		const rendered = component.render(80).join("\n");

		expect(component.children[0]).toBeInstanceOf(DPiNativeUserMessageComponent);
		expect(rendered).not.toContain("[meta(");
		expect(rendered).not.toContain("connectId");
		expect(rendered.match(/ls 一下/g)).toHaveLength(1);
	});

	it("renders tool calls and tool results as native tool execution components", () => {
		const output = Array.from({ length: 24 }, (_, index) => `entry-${index + 1}`).join("\n");
		const state = {
			...snapshot(),
			messages: [
				{
					...assistantMessage,
					content: [
						{ type: "text" as const, text: "我来查看目录。" },
						{ type: "toolCall" as const, id: "tool-1", name: "dispatch_ls", arguments: { path: "." } },
					],
					stopReason: "toolUse" as const,
				},
				{
					role: "toolResult" as const,
					toolCallId: "tool-1",
					toolName: "dispatch_ls",
					content: [{ type: "text" as const, text: output }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		const component = buildDPiInteractiveMessageListComponent(state, { color: true, colorMode: "truecolor" });
		const rendered = component.render(80).join("\n");
		const plain = stripAnsi(rendered);

		expect(component.children[1]).toBeInstanceOf(DPiNativeToolExecutionComponent);
		expect(plain).toContain("ls .");
		expect(plain).not.toContain("dispatch_ls");
		expect(plain).not.toContain('{"path":"."}');
		expect(plain).toContain("entry-20");
		expect(plain).not.toContain("entry-21");
		expect(plain).toContain("4 more lines");
		expect(rendered).not.toContain("────");
		expect(rendered).toContain("\x1b[48;2;40;50;40m");
	});

	it("uses native tool expansion state for dispatch tool output", () => {
		const output = Array.from({ length: 24 }, (_, index) => `entry-${index + 1}`).join("\n");
		const state = {
			...snapshot(),
			messages: [
				{
					...assistantMessage,
					content: [{ type: "toolCall" as const, id: "tool-1", name: "dispatch_ls", arguments: { path: "." } }],
					stopReason: "toolUse" as const,
				},
				{
					role: "toolResult" as const,
					toolCallId: "tool-1",
					toolName: "dispatch_ls",
					content: [{ type: "text" as const, text: output }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		const component = buildDPiInteractiveMessageListComponent(state, { toolsExpanded: true });
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("entry-24");
		expect(rendered).not.toContain("more lines");
	});

	it("renders bash with native last-visual-lines preview", () => {
		const rendered = renderToolPlain("dispatch_bash", { command: "printf test" }, numberedLines("line", 8));

		expect(rendered).toContain("$ printf test");
		expect(rendered).toContain("3 earlier lines");
		expect(rendered).not.toContain("line-1");
		expect(rendered).toContain("line-8");
	});

	it("renders read compact resource header and expands content like native", () => {
		const collapsed = renderToolPlain("dispatch_read", { path: "AGENTS.md" }, "line 1\nline 2", {
			cwd: "/repo",
		});
		const expanded = renderToolPlain("dispatch_read", { path: "AGENTS.md" }, "line 1\nline 2", {
			cwd: "/repo",
			toolsExpanded: true,
		});

		expect(collapsed).toContain("read resource AGENTS.md");
		expect(collapsed).toContain("ctrl+o to expand");
		expect(collapsed).not.toContain("line 1");
		expect(expanded).toContain("read AGENTS.md");
		expect(expanded).toContain("line 1");
	});

	it("renders write previews and hides successful results like native", () => {
		const rendered = renderToolPlain(
			"dispatch_write",
			{ path: "new.ts", content: numberedLines("line", 12) },
			"Successfully wrote",
		);

		expect(rendered).toContain("write new.ts");
		expect(rendered).toContain("line-10");
		expect(rendered).not.toContain("line-11");
		expect(rendered).toContain("2 more lines, 12 total");
		expect(rendered).not.toContain("Successfully wrote");
	});

	it("renders grep and find with native call labels and collapsed result counts", () => {
		const grep = renderToolPlain(
			"dispatch_grep",
			{ pattern: "TODO", path: ".", glob: "*.ts" },
			numberedLines("match", 16),
		);
		const find = renderToolPlain("dispatch_find", { pattern: "*.ts", path: "src" }, numberedLines("file", 24));

		expect(grep).toContain("grep /TODO/ in . (*.ts)");
		expect(grep).toContain("match-15");
		expect(grep).not.toContain("match-16");
		expect(grep).toContain("1 more lines");
		expect(find).toContain("find *.ts in src");
		expect(find).toContain("file-20");
		expect(find).not.toContain("file-21");
		expect(find).toContain("4 more lines");
	});

	it("renders edit with native self shell and diff output", () => {
		const rendered = renderToolPlain(
			"dispatch_edit",
			{ path: "file.ts", edits: [{ oldText: "old", newText: "new" }] },
			"Successfully replaced 1 block(s) in file.ts.",
			{
				details: {
					diff: "-1 old\n+1 new",
					firstChangedLine: 1,
				},
			},
		);

		expect(rendered).toContain("edit file.ts");
		expect(rendered).toContain("-1 old");
		expect(rendered).toContain("+1 new");
		expect(rendered).not.toContain("dispatch_edit");
		expect(rendered).not.toContain("Successfully replaced");
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

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function numberedLines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n");
}

function renderToolPlain(
	toolName: string,
	args: Record<string, unknown>,
	output: string,
	options: {
		cwd?: string;
		toolsExpanded?: boolean;
		details?: unknown;
		isError?: boolean;
	} = {},
): string {
	const state = {
		...snapshot(),
		messages: [
			{
				...assistantMessage,
				content: [{ type: "toolCall" as const, id: "tool-1", name: toolName, arguments: args }],
				stopReason: "toolUse" as const,
			},
			{
				role: "toolResult" as const,
				toolCallId: "tool-1",
				toolName,
				content: [{ type: "text" as const, text: output }],
				isError: options.isError ?? false,
				...(options.details === undefined ? {} : { details: options.details }),
				timestamp: 3,
			},
		],
	};
	const component = buildDPiInteractiveMessageListComponent(state, {
		cwd: options.cwd,
		toolsExpanded: options.toolsExpanded,
	});
	return stripAnsi(component.render(80).join("\n"));
}
