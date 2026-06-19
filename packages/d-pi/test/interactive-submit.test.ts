import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { Container, setKeybindings, type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AGENT_SWITCH_FILE } from "../src/extension/multi-agent-extension.ts";
import type {
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveSessionStateSnapshot,
} from "../src/tui/interactive/agent-session-proxy.ts";
import { DPI_NATIVE_CONNECT_BUILTIN_COMMANDS } from "../src/tui/interactive/native-parity-manifest.ts";
import {
	buildDPiConnectAgentSelectItems,
	createDPiConnectAutocompleteProvider,
	createDPiConnectRootLayout,
	extractDPiConnectSelectedAgentName,
	handleDPiConnectBashInput,
	handleDPiConnectSlashCommand,
	recordDPiConnectPromptHistory,
	showDPiConnectAgentSelector,
} from "../src/tui/interactive/run-connect-interactive-mode.ts";
import { submitDPiInteractiveEditorText } from "../src/tui/interactive/submit.ts";
import { DPiNativeCustomEditor } from "../src/tui/native/components/custom-editor.ts";
import { createDPiNativeKeybindings } from "../src/tui/native/keybindings.ts";
import { createDPiNativeTheme, getDPiNativeEditorTheme } from "../src/tui/native/theme/theme.ts";

class TestTerminal implements Terminal {
	readonly columns = 100;
	readonly rows = 30;
	readonly kittyProtocolActive = false;
	private onInput: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	emitInput(data: string): void {
		this.onInput?.(data);
	}
}

function createProxy(overrides: Partial<DPiInteractiveAgentSessionProxy> = {}): DPiInteractiveAgentSessionProxy {
	const proxy = {
		isStreaming: false,
		prompt: vi.fn(async () => {}),
		steer: vi.fn(),
	} as unknown as DPiInteractiveAgentSessionProxy;
	return { ...proxy, ...overrides };
}

describe("d-pi interactive editor submit", () => {
	it("reports prompt errors instead of leaving an unhandled rejection that crashes the TUI child", async () => {
		const error = new Error("prompt returned HTTP 500");
		const onError = vi.fn();
		const proxy = createProxy({
			prompt: vi.fn(async () => {
				throw error;
			}),
		});

		await expect(submitDPiInteractiveEditorText(proxy, "你好", onError)).resolves.toBeUndefined();

		expect(onError).toHaveBeenCalledWith(error);
		expect(proxy.prompt).toHaveBeenCalledWith("你好");
	});

	it("routes text to steer while the proxy is streaming", async () => {
		const proxy = createProxy({ isStreaming: true });

		await submitDPiInteractiveEditorText(proxy, "interrupt", vi.fn());

		expect(proxy.steer).toHaveBeenCalledWith("interrupt");
	});

	it("handles known connect slash commands locally instead of sending them as prompts", async () => {
		const statuses: string[] = [];
		const proxy = createProxy({
			prompt: vi.fn(async () => {}),
			reload: vi.fn(async () => {}),
			setModel: vi.fn(),
		});

		await expect(
			handleDPiConnectSlashCommand("/reload", {
				proxy,
				showStatus: (text) => statuses.push(text),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);
		await expect(
			handleDPiConnectSlashCommand("/model anthropic/claude-sonnet-4", {
				proxy,
				showStatus: (text) => statuses.push(text),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);

		expect(proxy.reload).toHaveBeenCalled();
		expect(proxy.setModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4");
		expect(proxy.prompt).not.toHaveBeenCalled();
		expect(statuses).toEqual(["Reloaded", "Model: anthropic/claude-sonnet-4"]);
	});

	it("shows remote slash command errors without rejecting out of the TUI input handler", async () => {
		const statuses: string[] = [];
		const proxy = createProxy({
			prompt: vi.fn(async () => {}),
			newSession: vi.fn(async () => {
				throw new Error("new-session returned HTTP 403");
			}),
		});

		await expect(
			handleDPiConnectSlashCommand("/new", {
				proxy,
				showStatus: (text) => statuses.push(text),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);

		expect(statuses).toEqual(["new-session returned HTTP 403"]);
		expect(proxy.prompt).not.toHaveBeenCalled();
	});

	it("leaves unknown slash commands available for remote command handling", async () => {
		const proxy = createProxy();

		await expect(
			handleDPiConnectSlashCommand("/unknown arg", {
				proxy,
				showStatus: vi.fn(),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(false);
	});

	it("handles the native connect builtin slash command surface locally except /trust fallback", async () => {
		const statuses: string[] = [];
		const proxy = createProxy({
			getSnapshot: vi.fn(
				() =>
					({
						isStreaming: false,
						isCompacting: false,
						isBashRunning: false,
						steeringMessages: [],
						followUpMessages: [],
						sessionName: "session",
						sessionFile: "/tmp/session.jsonl",
						cwd: "/tmp/workspace",
						model: "anthropic/claude-sonnet-4",
						thinkingLevel: "medium",
						messages: [{ role: "assistant", content: "last answer" }],
						contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
						tokenUsage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							usingSubscription: false,
						},
						modelInfo: {
							id: "claude-sonnet-4",
							provider: "anthropic",
							reasoning: true,
							contextWindow: 100,
						},
						autoCompactEnabled: true,
						availableProviderCount: 1,
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
						banner: { changelogMarkdown: "changes" },
					}) as unknown as DPiInteractiveSessionStateSnapshot,
			),
			compact: vi.fn(async () => {}),
			setModel: vi.fn(),
			newSession: vi.fn(async () => {}),
			fork: vi.fn(async () => {}),
			renameSession: vi.fn(),
			reload: vi.fn(async () => {}),
		});
		const handlers = {
			proxy,
			showStatus: (text: string) => statuses.push(text),
			showAgentSelector: vi.fn(async () => {}),
			showSourcesSelector: vi.fn(async () => {}),
			showModelSelector: vi.fn(async () => {}),
			showSettingsSelector: vi.fn(async () => {}),
			showScopedModelsSelector: vi.fn(async () => {}),
			showForkSelector: vi.fn(async () => {}),
			showTreeSelector: vi.fn(async () => {}),
			showResumeSelector: vi.fn(async () => {}),
			showPanel: vi.fn(),
			copyLastAssistantMessage: vi.fn(async () => {}),
			refreshAutocomplete: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
		};
		const commandText: Record<string, string> = {
			model: "/model",
			name: "/name renamed",
		};

		for (const command of DPI_NATIVE_CONNECT_BUILTIN_COMMANDS) {
			const handled = await handleDPiConnectSlashCommand(commandText[command] ?? `/${command}`, handlers);
			expect(handled, command).toBe(command !== "trust");
		}

		expect(handlers.showSettingsSelector).toHaveBeenCalled();
		expect(handlers.showModelSelector).toHaveBeenCalled();
		expect(handlers.showScopedModelsSelector).toHaveBeenCalled();
		expect(handlers.showForkSelector).toHaveBeenCalled();
		expect(handlers.showTreeSelector).toHaveBeenCalled();
		expect(handlers.showResumeSelector).toHaveBeenCalled();
		expect(handlers.showPanel).toHaveBeenCalledWith("Session", expect.stringContaining("Session: session"));
		expect(handlers.showPanel).toHaveBeenCalledWith("Changelog", "changes");
		expect(handlers.copyLastAssistantMessage).toHaveBeenCalled();
		expect(handlers.refreshAutocomplete).toHaveBeenCalled();
		expect(statuses).toContain("Not available in connect mode");
		expect(statuses).toContain("Not available in connect mode — configure auth on the server");
		expect(proxy.prompt).not.toHaveBeenCalled();
	});

	it("blocks native bash prefixes in connect mode instead of sending them as prompts", () => {
		const statuses: string[] = [];

		expect(handleDPiConnectBashInput("!", (text) => statuses.push(text))).toBe(true);
		expect(handleDPiConnectBashInput("!! pwd", (text) => statuses.push(text))).toBe(true);
		expect(handleDPiConnectBashInput("hello", (text) => statuses.push(text))).toBe(false);
		expect(statuses).toEqual(["Not available in connect mode", "Not available in connect mode"]);
	});

	it("records submitted prompts so the native editor up arrow recalls history", () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const keybindings = createDPiNativeKeybindings();
		setKeybindings(keybindings);
		const theme = createDPiNativeTheme({ color: false });
		const editor = new DPiNativeCustomEditor(tui, getDPiNativeEditorTheme(theme), keybindings);

		recordDPiConnectPromptHistory(editor, "first prompt");
		recordDPiConnectPromptHistory(editor, "/new");
		recordDPiConnectPromptHistory(editor, "! pwd");
		editor.setText("");
		editor.handleInput("\x1b[A");

		expect(editor.getText()).toBe("first prompt");
	});

	it("handles /agents locally instead of sending it as a prompt", async () => {
		const proxy = createProxy();
		const showAgentSelector = vi.fn(async () => {});

		await expect(
			handleDPiConnectSlashCommand("/agents", {
				proxy,
				showStatus: vi.fn(),
				showAgentSelector,
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);

		expect(showAgentSelector).toHaveBeenCalled();
		expect(proxy.prompt).not.toHaveBeenCalled();
	});

	it("handles /sources locally instead of sending it as a prompt", async () => {
		const proxy = createProxy();
		const showSourcesSelector = vi.fn(async () => {});

		await expect(
			handleDPiConnectSlashCommand("/sources", {
				proxy,
				showStatus: vi.fn(),
				showSourcesSelector,
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);

		expect(showSourcesSelector).toHaveBeenCalled();
		expect(proxy.prompt).not.toHaveBeenCalled();
	});

	it("builds and parses native agent selector items", () => {
		const items = buildDPiConnectAgentSelectItems(
			{
				rootName: "root",
				agents: [
					{
						name: "root",
						parentName: undefined,
						status: "ready",
						model: "anthropic/sonnet",
						children: ["helper"],
					},
					{ name: "helper", parentName: "root", status: "busy", model: undefined, children: [] },
				],
				executors: [],
			},
			"helper",
		);

		expect(items.map((item) => item.value)).toEqual(["root", "helper"]);
		expect(items[0]?.label).toContain("root (anthropic/sonnet)");
		expect(items[1]?.label).toContain("helper");
		expect(items[1]?.label).toContain("◀");
		expect(extractDPiConnectSelectedAgentName(items[1]!.value)).toBe("helper");
	});

	it("builds the native interactive root container order", () => {
		const layout = createDPiConnectRootLayout();

		expect(layout.root.children).toEqual([
			layout.headerContainer,
			layout.chatContainer,
			layout.pendingMessagesContainer,
			layout.statusContainer,
			layout.widgetContainerAbove,
			layout.editorContainer,
			layout.widgetContainerBelow,
			layout.footerContainer,
		]);
	});

	it("routes keyboard input to the native agent selector in the editor slot", async () => {
		if (existsSync(AGENT_SWITCH_FILE)) {
			unlinkSync(AGENT_SWITCH_FILE);
		}
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const keybindings = createDPiNativeKeybindings();
		setKeybindings(keybindings);
		const theme = createDPiNativeTheme({ color: false });
		const editor = new DPiNativeCustomEditor(tui, getDPiNativeEditorTheme(theme), keybindings);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(editorContainer);
		tui.setFocus(editor);
		tui.start();

		await showDPiConnectAgentSelector({
			tui,
			editor,
			editorContainer,
			theme,
			hubUrl: "https://dp.example",
			fetch: vi.fn(async () =>
				Response.json({
					rootName: "root",
					agents: [
						{ name: "root", parentName: undefined, status: "ready", model: undefined, children: ["helper"] },
						{ name: "helper", parentName: "root", status: "ready", model: undefined, children: [] },
					],
					executors: [],
				}),
			),
			currentAgentName: "root",
			showStatus: vi.fn(),
			stop: vi.fn(async () => {}),
		});

		expect(tui.hasOverlay()).toBe(false);
		expect(editorContainer.children[0]).not.toBe(editor);
		terminal.emitInput("\r");

		expect(readFileSync(AGENT_SWITCH_FILE, "utf-8")).toBe("root");
		unlinkSync(AGENT_SWITCH_FILE);
		tui.stop();
	});

	it("builds slash command autocomplete from connect commands", async () => {
		const provider = createDPiConnectAutocompleteProvider(
			[
				{ name: "reload", description: "Reload resources", source: "builtin" },
				{ name: "agents", description: "Switch agent", source: "extension" },
			],
			"/tmp/workspace",
		);

		const suggestions = await provider.getSuggestions(["/re"], 0, 3, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.prefix).toBe("/re");
		expect(suggestions?.items).toContainEqual({
			value: "reload",
			label: "reload",
			description: "Reload resources",
		});
	});
});
