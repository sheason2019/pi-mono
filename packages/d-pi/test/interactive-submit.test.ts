import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Container, setKeybindings, type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AGENT_SWITCH_FILE } from "../src/multi-agent/multi-agent-extension.ts";
import type {
	DPiInteractiveAgentSessionEvent,
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveSessionStateSnapshot,
} from "../src/tui/interactive/agent-session-proxy.ts";
import { DPI_NATIVE_CONNECT_BUILTIN_COMMANDS } from "../src/tui/interactive/native-parity-manifest.ts";
import {
	buildDPiConnectAgentSelectItems,
	createDPiConnectAutocompleteProvider,
	createDPiConnectClientState,
	createDPiConnectRootLayout,
	extractDPiConnectSelectedAgentName,
	handleDPiConnectBashInput,
	handleDPiConnectSlashCommand,
	loadDPiConnectTuiComponents,
	recordDPiConnectPromptHistory,
	runDPiConnectInteractiveMode,
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
	stopCalls = 0;
	drainInputCalls = 0;
	readonly writes: string[] = [];
	private onInput: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.stopCalls += 1;
	}
	async drainInput(): Promise<void> {
		this.drainInputCalls += 1;
	}
	write(data = ""): void {
		this.writes.push(data);
	}
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
	output(): string {
		return this.writes.join("");
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

function connectSnapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "anthropic/claude-sonnet-4",
		isStreaming: false,
		isCompacting: false,
		steeringMessages: [],
		sessionFile: undefined,
		sessionName: undefined,
		messages: [],
		banner: undefined,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
		contextUsage: { tokens: 0, contextWindow: 100, percent: 0 },
		modelInfo: { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 100 },
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
			treeFilterMode: "all",
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

describe("d-pi interactive editor submit", () => {
	it("loads workspace TUI component modules from the hub and registers their renderers", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const textUrl = typeof url === "string" ? url : url.toString();
			calls.push({ url: textUrl, init });
			if (textUrl === "https://dp.example/_hub/.public/tui-components") {
				return new Response(
					JSON.stringify({
						components: [{ name: "meta.ts", url: "https://dp.example/_hub/.public/tui-components/meta.ts" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (textUrl === "https://dp.example/_hub/.public/tui-components/meta.ts") {
				return new Response(
					[
						`export { default } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "public", "d-pi-message.ts")).href)};`,
					].join("\n"),
					{ status: 200, headers: { "Content-Type": "text/typescript" } },
				);
			}
			return new Response("missing", { status: 404 });
		});

		const renderers = await loadDPiConnectTuiComponents({
			hubUrl: "https://dp.example",
			authHeaders: { Authorization: "Bearer token" },
			fetch: fetchFn as typeof fetch,
		});

		expect(Object.keys(renderers)).toEqual(["d-pi-message"]);
		expect(calls.map((call) => call.url)).toEqual([
			"https://dp.example/_hub/.public/tui-components",
			"https://dp.example/_hub/.public/tui-components/meta.ts",
		]);
		expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer token" });
		expect(calls[1]?.init?.headers).toEqual({ Authorization: "Bearer token" });
	});

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
		});

		await expect(
			handleDPiConnectSlashCommand("/reload", {
				proxy,
				showStatus: (text) => statuses.push(text),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);

		expect(proxy.reload).toHaveBeenCalled();
		expect(proxy.prompt).not.toHaveBeenCalled();
		expect(statuses).toEqual(["Reloaded"]);
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
						steeringMessages: [],
						sessionName: "session",
						sessionFile: "/tmp/session.jsonl",
						cwd: "/tmp/workspace",
						model: "anthropic/claude-sonnet-4",
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
							enableSkillCommands: true,
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
							treeFilterMode: "all",
							showHardwareCursor: false,
							editorPaddingX: 0,
							autocompleteMaxVisible: 10,
							quietStartup: false,
							clearOnShrink: true,
							showTerminalProgress: true,
							warnings: {},
						},
						banner: { changelogMarkdown: "changes" },
					}) as unknown as DPiInteractiveSessionStateSnapshot,
			),
			compact: vi.fn(async () => {}),
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
			name: "/name renamed",
		};

		for (const command of DPI_NATIVE_CONNECT_BUILTIN_COMMANDS) {
			const handled = await handleDPiConnectSlashCommand(commandText[command] ?? `/${command}`, handlers);
			expect(handled, command).toBe(command !== "trust");
		}

		expect(handlers.showSettingsSelector).toHaveBeenCalled();
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

	it("gracefully shuts down connect TUI on double ctrl+c", async () => {
		const terminal = new TestTerminal();
		const disconnect = vi.fn();
		const exitCodes: Array<number | undefined> = [];
		const proxy = createProxy({
			connect: vi.fn(async () => {}),
			disconnect,
			getSnapshot: vi.fn(() => connectSnapshot()),
			subscribe: vi.fn(() => vi.fn()),
			clearQueue: vi.fn(() => ({ steering: [] })),
		} as Partial<DPiInteractiveAgentSessionProxy> & { connect(): Promise<void>; disconnect(): void });
		const options = {
			agentUrl: "https://dp.example/agents/root",
			hubUrl: "https://dp.example",
			terminal,
			proxy,
			exit: (code?: number) => {
				exitCodes.push(code);
			},
		};
		await runDPiConnectInteractiveMode(options);

		terminal.emitInput("\x03");
		terminal.emitInput("\x03");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(terminal.drainInputCalls).toBe(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(terminal.stopCalls).toBe(1);
		expect(exitCodes).toEqual([0]);
	});

	it("shows the double-ctrl-c hint outside the message list after a single ctrl+c", async () => {
		const terminal = new TestTerminal();
		const exit = vi.fn();
		const proxy = createProxy({
			connect: vi.fn(async () => {}),
			disconnect: vi.fn(),
			getSnapshot: vi.fn(() => connectSnapshot()),
			subscribe: vi.fn(() => vi.fn()),
			clearQueue: vi.fn(() => ({ steering: [] })),
		} as Partial<DPiInteractiveAgentSessionProxy> & { connect(): Promise<void>; disconnect(): void });
		const handle = await runDPiConnectInteractiveMode({
			agentUrl: "https://dp.example/agents/root",
			hubUrl: "https://dp.example",
			terminal,
			proxy,
			exit,
		});

		terminal.emitInput("\x03");
		await new Promise<void>((resolve) => setTimeout(resolve, 30));

		expect(terminal.output()).toContain("Press ctrl+c again to exit");
		expect(exit).not.toHaveBeenCalled();
		await handle.stop();
	});

	it("expands the connect startup header hints with ctrl+o", async () => {
		const terminal = new TestTerminal();
		const proxy = createProxy({
			connect: vi.fn(async () => {}),
			disconnect: vi.fn(),
			getSnapshot: vi.fn(() => connectSnapshot()),
			subscribe: vi.fn(() => vi.fn()),
			clearQueue: vi.fn(() => ({ steering: [] })),
		} as Partial<DPiInteractiveAgentSessionProxy> & { connect(): Promise<void>; disconnect(): void });
		const handle = await runDPiConnectInteractiveMode({
			agentUrl: "https://dp.example/agents/root",
			hubUrl: "https://dp.example",
			terminal,
			proxy,
			exit: vi.fn(),
		});

		terminal.emitInput("\x0f");
		await new Promise<void>((resolve) => setTimeout(resolve, 30));

		expect(terminal.output()).toContain("ctrl+c twice to exit");
		await handle.stop();
	});

	it("shows the native compacting loader in the status area while compacting", async () => {
		const terminal = new TestTerminal();
		const snapshot = connectSnapshot();
		const listeners: Array<(event: DPiInteractiveAgentSessionEvent) => void> = [];
		const proxy = createProxy({
			connect: vi.fn(async () => {}),
			disconnect: vi.fn(),
			getSnapshot: vi.fn(() => snapshot),
			subscribe: vi.fn((listener: (event: DPiInteractiveAgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			}),
			clearQueue: vi.fn(() => ({ steering: [] })),
		} as Partial<DPiInteractiveAgentSessionProxy> & { connect(): Promise<void>; disconnect(): void });
		const handle = await runDPiConnectInteractiveMode({
			agentUrl: "https://dp.example/agents/root",
			hubUrl: "https://dp.example",
			terminal,
			proxy,
			exit: vi.fn(),
		});

		snapshot.isCompacting = true;
		for (const listener of listeners) {
			listener({ type: "compaction_start" });
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 30));

		expect(terminal.output()).toContain("Compacting context...");
		expect(terminal.output()).toContain("to cancel");

		snapshot.isCompacting = false;
		for (const listener of listeners) {
			listener({ type: "compaction_end" });
		}
		await handle.stop();
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
						children: ["helper"],
					},
					{ name: "helper", parentName: "root", status: "busy", children: [] },
				],
				executors: [],
			},
			"helper",
		);

		expect(items.map((item) => item.value)).toEqual(["root", "helper"]);
		expect(items[0]?.label).toContain("root");
		expect(items[0]?.label).not.toContain("anthropic/sonnet");
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

	it("creates isolated client state for each connect TUI instance", () => {
		const first = createDPiConnectClientState();
		const second = createDPiConnectClientState();

		first.errors.push("first error");
		first.turnStatusEntries.push({ afterMessageCount: 1, text: "first status" });
		first.toolsExpanded = true;
		first.lastCtrlCTime = 123;

		expect(second).toMatchObject({
			errors: [],
			turnStatusEntries: [],
			toolsExpanded: false,
			lastCtrlCTime: 0,
			stopped: false,
			shuttingDown: false,
		});
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
						{ name: "root", parentName: undefined, status: "ready", children: ["helper"] },
						{ name: "helper", parentName: "root", status: "ready", children: [] },
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
				{ name: "agents", description: "Switch agent", source: "agent" },
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
