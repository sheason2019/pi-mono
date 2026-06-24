import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { DPiInteractiveSessionStateSnapshot } from "../src/tui/interactive/agent-session-proxy.ts";
import { buildDPiInteractiveBannerView } from "../src/tui/interactive/banner-view.ts";
import { buildDPiInteractiveFooterView } from "../src/tui/interactive/footer-view.ts";
import {
	buildDPiInteractiveMessageListComponent,
	buildDPiInteractiveMessageListView,
	buildDPiInteractivePendingMessagesComponent,
	buildDPiInteractiveStatusView,
} from "../src/tui/interactive/message-list-view.ts";

function snapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "claude-sonnet-4",
		isStreaming: true,
		isCompacting: false,
		isBashRunning: false,
		steeringMessages: ["interrupt"],
		followUpMessages: ["continue"],
		sessionFile: "/tmp/session.jsonl",
		sessionName: "launch",
		messages: [
			{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "分析中" },
					{ type: "text", text: "你好，我在。" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				stopReason: "stop",
				usage: {
					input: 1200,
					output: 300,
					cacheRead: 800,
					cacheWrite: 100,
					totalTokens: 2400,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
				},
				timestamp: 2,
			},
		],
		banner: {
			appName: "d-pi",
			version: "0.6.0-alpha.8",
			expandedHints: [{ key: "Ctrl+C", description: "to interrupt" }],
			compactHints: [{ key: "/", description: "for commands" }],
			compactOnboarding: "Remote-first coding agent",
			onboarding: "Welcome to d-pi",
			loadedResources: [
				{ name: "Context", compactList: "AGENTS.md", expandedList: "AGENTS.md\nteam-template/AGENTS.md" },
			],
			diagnostics: [{ label: "Extension issues", entries: [{ type: "warning", message: "sample warning" }] }],
			changelogMarkdown: "### Changed\n- parity",
		},
		tokenUsage: {
			input: 1200,
			output: 300,
			cacheRead: 800,
			cacheWrite: 100,
			cost: 0.123,
			usingSubscription: false,
			latestCacheHitRate: 38.1,
		},
		contextUsage: { tokens: 2400, contextWindow: 200000, percent: 1.2 },
		modelInfo: { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 200000 },
		autoCompactEnabled: true,
		cwd: "/Users/example/workspace",
		availableProviderCount: 2,
		remoteSettings: {
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
		extensionPaths: [],
	};
}

describe("d-pi interactive view parity components", () => {
	it("can render native-style ANSI colors for interactive TUI surfaces", () => {
		const banner = buildDPiInteractiveBannerView(snapshot().banner, { color: true, colorMode: "truecolor" });
		const footer = buildDPiInteractiveFooterView({
			snapshot: snapshot(),
			gitBranch: "feature/parity",
			width: 120,
			color: true,
			colorMode: "truecolor",
		});
		const messages = buildDPiInteractiveMessageListView(snapshot(), { color: true, colorMode: "truecolor" });

		expect(banner.text).toMatch(/\x1b\[/);
		expect(footer.text).toMatch(/\x1b\[/);
		expect(messages.text).toMatch(/\x1b\[/);
		expect(banner.text).toContain("d-pi");
		expect(banner.text).toContain("v0.6.0-alpha.8");
		expect(messages.text).toContain(" 你好");
		expect(footer.text).toContain("claude-sonnet-4");
		expect(banner.text).toContain("\x1b[38;2;240;198;116m[Context]\x1b[39m");
		expect(banner.text).toContain("\x1b[38;2;138;190;183md-pi\x1b[39m");
	});

	it("renders user messages through a native-style full-width box component", () => {
		const component = buildDPiInteractiveMessageListComponent(snapshot(), { color: true, colorMode: "truecolor" });
		const lines = component.render(40);

		expect(lines.some((line) => line.includes("\x1b[48;2;52;53;65m"))).toBe(true);
		expect(lines.some((line) => visibleWidth(line) === 40)).toBe(true);
		expect(lines.join("\n")).toContain("你好");
	});

	it("keeps queued steering messages out of the message list and ignores legacy follow-up state", () => {
		const messageList = buildDPiInteractiveMessageListComponent(snapshot(), { color: false });
		const pendingMessages = buildDPiInteractivePendingMessagesComponent(snapshot(), { color: false });

		expect(messageList.render(80).join("\n")).not.toContain("Steering:");
		expect(messageList.render(80).join("\n")).not.toContain("Follow-up:");
		expect(pendingMessages.render(80).join("\n")).toContain("Steering: interrupt");
		expect(pendingMessages.render(80).join("\n")).not.toContain("Follow-up: continue");
		expect(pendingMessages.render(80).join("\n")).toContain("↳ alt+up to edit all queued messages");
	});

	it("renders working status and token speed estimates like native turn stats", () => {
		const working = buildDPiInteractiveStatusView({ isStreaming: true }, undefined, { color: true });
		const stats = buildDPiInteractiveStatusView(
			{ isStreaming: false },
			{ tps: 12.345, output: 678, input: 1234, cacheRead: 23000, cacheWrite: 0, total: 24912, duration: 4.56 },
			{ color: true },
		);

		expect(working.text).toContain("Working...");
		expect(working.text).toMatch(/\x1b\[/);
		expect(stats.text).toContain("TPS 12.3 tok/s");
		expect(stats.text).toContain("out 678");
		expect(stats.text).toContain("in 1.2k");
		expect(stats.text).toContain("cache r/w 23k/0");
		expect(stats.text).toContain("total 25k");
	});

	// Parity marker: startup-banner:banner-resources-diagnostics
	it("renders the startup banner with hints, resources, diagnostics, and changelog", () => {
		const view = buildDPiInteractiveBannerView(snapshot().banner);

		expect(view.text).toContain(" d-pi v0.6.0-alpha.8");
		expect(view.text).toContain("/ for commands");
		expect(view.text).toContain("[Context]\n  AGENTS.md");
		expect(view.text).toContain("[Extension issues]");
		expect(view.text).toContain("sample warning");
		expect(view.text).toContain("### Changed");
	});

	it("renders native pi startup header and resource sections in order", () => {
		const view = buildDPiInteractiveBannerView({
			appName: "pi",
			version: "0.79.6",
			expandedHints: [
				{ key: "escape", description: "to interrupt" },
				{ key: "ctrl+c", description: "to clear" },
				{ key: "ctrl+c twice", description: "to exit" },
			],
			compactHints: [
				{ key: "escape", description: "interrupt" },
				{ key: "ctrl+c/ctrl+d", description: "clear/exit" },
				{ key: "/", description: "commands" },
				{ key: "!", description: "bash" },
				{ key: "ctrl+o", description: "more" },
			],
			compactOnboarding: "Press ctrl+o to show full startup help and loaded resources.",
			onboarding: "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
			loadedResources: [
				{
					name: "Context",
					compactList: "~/workspace/AGENTS.md, ~/workspace/project/AGENTS.md",
					expandedList: "~/workspace/AGENTS.md\n~/workspace/project/AGENTS.md",
				},
				{
					name: "Skills",
					compactList: "tmux, using-superpowers",
					expandedList: "~/.claude/skills/tmux/SKILL.md\n~/.agents/skills/superpowers/using-superpowers/SKILL.md",
				},
			],
			diagnostics: [
				{
					label: "Skill conflicts",
					entries: [
						{
							type: "collision",
							message: "collision",
							collision: {
								resourceType: "skill",
								name: "using-superpowers",
								winnerPath: "~/.agents/skills/superpowers/using-superpowers/SKILL.md",
								loserPath: "~/.agents/skills/using-superpowers/SKILL.md",
								winnerSource: "user",
							},
						},
					],
				},
			],
			changelogMarkdown: undefined,
		});

		expect(view.text).toContain("\n pi v0.79.6\n");
		expect(view.text).toContain("escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more");
		expect(view.text).not.toContain("ctrl+c twice to exit");
		expect(view.text).toContain("[Context]\n  ~/workspace/AGENTS.md, ~/workspace/project/AGENTS.md");
		expect(view.text).toContain("[Skills]\n  tmux, using-superpowers");
		expect(view.text).toContain('[Skill conflicts]\n  "using-superpowers" collision:');
		expect(view.text).toContain("    ✓ auto (user) ~/.agents/skills/superpowers/using-superpowers/SKILL.md");
		expect(view.text).toContain("    ✗ ~/.agents/skills/using-superpowers/SKILL.md (skipped)");
	});

	it("renders expanded startup hints like native when tools are expanded", () => {
		const view = buildDPiInteractiveBannerView(
			{
				appName: "pi",
				version: "0.79.6",
				expandedHints: [
					{ key: "escape", description: "to interrupt" },
					{ key: "ctrl+c", description: "to clear" },
					{ key: "ctrl+c twice", description: "to exit" },
					{ key: "ctrl+d", description: "to exit (empty)" },
					{ key: "shift+tab", description: "to cycle thinking level" },
					{ key: "ctrl+t", description: "to expand thinking" },
					{ key: "ctrl+g", description: "for external editor" },
					{ key: "alt+enter", description: "to queue follow-up" },
					{ key: "alt+up", description: "to edit all queued messages" },
				],
				compactHints: [
					{ key: "escape", description: "interrupt" },
					{ key: "ctrl+c/ctrl+d", description: "clear/exit" },
				],
				compactOnboarding: "Press ctrl+o to show full startup help and loaded resources.",
				onboarding: "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
				loadedResources: [],
				diagnostics: [],
				changelogMarkdown: undefined,
			},
			{ expanded: true },
		);

		expect(view.text).toContain("escape to interrupt\n ctrl+c to clear\n ctrl+c twice to exit");
		expect(view.text).not.toContain("cycle models");
		expect(view.text).not.toContain("select model");
		expect(view.text).toContain("alt+enter to queue follow-up");
		expect(view.text).not.toContain("ctrl+c/ctrl+d clear/exit");
		expect(view.text).not.toContain("ctrl+n/ctrl+p");
		expect(view.text).not.toContain("ctrl+m");
		expect(view.text).not.toContain("Press ctrl+o to show full startup help and loaded resources.");
	});

	// Parity marker: footer-status:runtime-status-footer
	it("renders footer token/cache/context/model/thinking/session details from interactive snapshot", () => {
		const view = buildDPiInteractiveFooterView({ snapshot: snapshot(), gitBranch: "feature/parity", width: 120 });

		expect(view.lines[0]).toContain("/Users/example/workspace (feature/parity) • launch");
		expect(view.lines[1]).toContain("↑1.2k");
		expect(view.lines[1]).toContain("↓300");
		expect(view.lines[1]).toContain("R800");
		expect(view.lines[1]).toContain("W100");
		expect(view.lines[1]).toContain("CH38.1%");
		expect(view.lines[1]).toContain("$0.123");
		expect(view.lines[1]).toContain("1.2%/200k (auto)");
		expect(view.lines[1]).toContain("(anthropic) claude-sonnet-4");
	});

	it("renders OpenRouter prefixed model ids like native pi footer aliases", () => {
		const state = {
			...snapshot(),
			model: "stepfun/step-3.7-flash",
			modelInfo: {
				id: "stepfun/step-3.7-flash",
				provider: "openrouter",
				reasoning: true,
				contextWindow: 256000,
			},
			contextUsage: { tokens: 0, contextWindow: 256000, percent: 0 },
		};

		const view = buildDPiInteractiveFooterView({ snapshot: state, width: 120 });

		expect(view.lines[1]).toContain("0.0%/256k (auto)");
		expect(view.lines[1]).toContain("(stepfun) step-3.7-flash");
		expect(view.lines[1]).not.toContain("(openrouter) stepfun/step-3.7-flash");
	});

	// Parity marker: message-rendering:assistant-and-user-transcript
	it("renders user, assistant text, thinking, and queue state without worker JSON", () => {
		const view = buildDPiInteractiveMessageListView(snapshot());

		expect(view.text).toContain(" 你好");
		expect(view.text).toContain(" 分析中");
		expect(view.text).toContain(" 你好，我在。");
		expect(view.text).toContain("steer queued: interrupt");
		expect(view.text).not.toContain("follow-up queued: continue");
		expect(view.text).not.toContain("worker.state");
		expect(view.text).not.toContain("extensions");
	});

	it("strips d-pi transport meta wrappers before rendering transcript text", () => {
		const state = {
			...snapshot(),
			messages: [
				{
					role: "user" as const,
					content: '[meta({"createTime":"2026/06/19 08:36:14","sourceType":"connect","connectId":"id"})]\n你好',
					timestamp: 1,
				},
			],
		};

		const view = buildDPiInteractiveMessageListView(state);

		expect(view.text).toContain(" 你好");
		expect(view.text).not.toContain("[meta(");
		expect(view.text).not.toContain("connectId");
	});

	it("renders compact completion divider as a persistent transcript boundary", () => {
		const state = {
			...snapshot(),
			messages: [
				{ role: "user" as const, content: "before compact", timestamp: 1 },
				{
					role: "custom" as const,
					customType: "compact-divider",
					content: "Compact completed 15s",
					display: true,
					details: {
						summary: "The compacted session focused on remote-first view model pagination.",
						tokensBefore: 12345,
					},
					timestamp: 2,
				},
				{ role: "user" as const, content: "after compact", timestamp: 3 },
			],
		};

		const view = buildDPiInteractiveMessageListView(state);

		expect(view.text).toContain("before compact");
		expect(view.text).toContain("Compact completed 15s");
		expect(view.text).toContain("The compacted session focused on remote-first view model pagination.");
		expect(view.text).toContain("────────────────");
		expect(view.text).toContain("after compact");
		expect(view.text).toContain(
			"──────────────── Compact completed 15s ────────────────\n\n The compacted session focused on remote-first view model pagination.",
		);
	});

	it("renders compact completion label with only the top divider in the component view", () => {
		const state = {
			...snapshot(),
			messages: [
				{
					role: "custom" as const,
					customType: "compact-divider",
					content: "Compact completed 15s",
					display: true,
					details: {
						summary: "Persisted compact summary",
						tokensBefore: 12345,
					},
					timestamp: 1,
				},
			],
		};

		const rendered = buildDPiInteractiveMessageListComponent(state, { color: false }).render(40);

		expect(rendered.filter((line) => line === "─".repeat(40))).toHaveLength(1);
		expect(rendered.join("\n")).toContain("Compact completed 15s");
		expect(rendered.join("\n")).toContain("Persisted compact summary");
	});

	it("renders persisted transcript items without requiring message compatibility entries", () => {
		const state = {
			...snapshot(),
			messages: [],
			transcriptItems: [
				{
					id: "notice-1",
					type: "notice" as const,
					level: "error" as const,
					text: "Runtime failed",
					timestamp: 1,
				},
				{
					id: "tool-state-1",
					type: "tool_state" as const,
					toolCallId: "tool-1",
					toolName: "ls",
					status: "succeeded" as const,
					result: { content: [{ type: "text", text: "agent.ts" }] },
					timestamp: 2,
				},
				{
					id: "turn-stats-1",
					type: "turn_stats" as const,
					tps: 12.3,
					output: 4,
					input: 10,
					cacheRead: 5,
					cacheWrite: 0,
					total: 19,
					duration: 0.4,
					timestamp: 3,
				},
			],
		};

		const rendered = buildDPiInteractiveMessageListComponent(state, { color: false }).render(80).join("\n");

		expect(rendered).toContain("Runtime failed");
		expect(rendered).toContain("ls");
		expect(rendered).toContain("agent.ts");
		expect(rendered).toContain("TPS 12.3 tok/s");
	});

	it("does not duplicate turn stats when transcript items and legacy status entries overlap", () => {
		const state = {
			...snapshot(),
			messages: [],
			transcriptItems: [
				{
					id: "turn-stats-1",
					type: "turn_stats" as const,
					tps: 12.3,
					output: 4,
					input: 10,
					cacheRead: 5,
					cacheWrite: 0,
					total: 19,
					duration: 0.4,
					timestamp: 3,
				},
			],
		};

		const rendered = buildDPiInteractiveMessageListComponent(state, {
			color: false,
			statusEntries: [{ afterMessageCount: 1, text: "TPS 12.3 tok/s, out 4, in 10, cache r/w 5/0, total 19, 0.4s" }],
		})
			.render(80)
			.join("\n");

		expect(rendered.match(/TPS 12\.3 tok\/s/g)).toHaveLength(1);
	});
});
