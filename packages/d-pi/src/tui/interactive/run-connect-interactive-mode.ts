import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Container,
	getKeybindings,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SlashCommand,
	Spacer,
	setKeybindings,
	type Terminal,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import { AGENT_SWITCH_FILE } from "../../extension/multi-agent-extension.ts";
import type { AgentStatus, SourceInfo, TeamAgentEntry, TeamSnapshot } from "../../types.ts";
import { DPiNativeCustomEditor } from "../native/components/custom-editor.ts";
import { DPiNativeDynamicBorder } from "../native/components/dynamic-border.ts";
import { DPiNativeStatusContainer } from "../native/components/status-container.ts";
import { createDPiNativeKeybindings } from "../native/keybindings.ts";
import {
	createDPiNativeTheme,
	type DPiNativeTheme,
	getDPiNativeEditorTheme,
	getDPiNativeSelectListTheme,
} from "../native/theme/theme.ts";
import type {
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveBannerData,
	DPiInteractiveRemoteSettings,
	DPiInteractiveSessionItemData,
	DPiInteractiveSessionStateSnapshot,
	DPiInteractiveSlashCommand,
	DPiInteractiveTreeNodeData,
	DPiInteractiveUserMessageItem,
} from "./agent-session-proxy.ts";
import { buildDPiInteractiveBannerView } from "./banner-view.ts";
import { buildDPiInteractiveFooterView } from "./footer-view.ts";
import {
	buildDPiInteractiveMessageListComponent,
	buildDPiInteractivePendingMessagesComponent,
	buildDPiInteractiveStatusView,
	type DPiInteractiveStatusEntry,
} from "./message-list-view.ts";
import { createDPiInteractiveRemoteAgentSessionProxy } from "./remote-agent-session-proxy.ts";
import { submitDPiInteractiveEditorText } from "./submit.ts";

export interface RunDPiConnectInteractiveModeOptions {
	agentUrl: string;
	hubUrl: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	terminal?: Terminal;
	proxy?: DPiInteractiveAgentSessionProxy & { connect?(): Promise<void>; disconnect?(): void };
	gitBranch?: string | null;
	exit?: (code: number) => void;
}

export interface DPiConnectInteractiveModeHandle {
	tui: TUI;
	proxy: DPiInteractiveAgentSessionProxy;
	stop(): Promise<void>;
}

export interface DPiConnectRootLayout {
	root: Container;
	headerContainer: Container;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	editorContainer: Container;
	widgetContainerBelow: Container;
	footerContainer: Container;
}

export interface DPiConnectStartupBannerEnv {
	HOME?: string;
	DPI_NATIVE_PI_VERSION?: string;
}

export function createDPiConnectRootLayout(): DPiConnectRootLayout {
	const root = new Container();
	const headerContainer = new Container();
	const chatContainer = new Container();
	const pendingMessagesContainer = new Container();
	const statusContainer = new Container();
	const widgetContainerAbove = new Container();
	const editorContainer = new Container();
	const widgetContainerBelow = new Container();
	const footerContainer = new Container();
	root.addChild(headerContainer);
	root.addChild(chatContainer);
	root.addChild(pendingMessagesContainer);
	root.addChild(statusContainer);
	root.addChild(widgetContainerAbove);
	root.addChild(editorContainer);
	root.addChild(widgetContainerBelow);
	root.addChild(footerContainer);
	return {
		root,
		headerContainer,
		chatContainer,
		pendingMessagesContainer,
		statusContainer,
		widgetContainerAbove,
		editorContainer,
		widgetContainerBelow,
		footerContainer,
	};
}

export interface DPiConnectSlashCommandHandlers {
	proxy: DPiInteractiveAgentSessionProxy;
	showStatus(text: string): void;
	showAgentSelector?(): Promise<void>;
	showSourcesSelector?(): Promise<void>;
	showSettingsSelector?(): Promise<void>;
	showForkSelector?(): Promise<void>;
	showTreeSelector?(): Promise<void>;
	showResumeSelector?(): Promise<void>;
	showPanel?(title: string, body: string): void;
	copyLastAssistantMessage?(): Promise<void>;
	refreshAutocomplete?(): Promise<void>;
	stop(): Promise<void>;
}

export interface DPiConnectAutocompleteEditor {
	setAutocompleteProvider(provider: AutocompleteProvider): void;
}

export interface DPiConnectHistoryEditor {
	addToHistory?(text: string): void;
}

export interface DPiConnectClientState {
	errors: string[];
	turnStatusEntries: DPiInteractiveStatusEntry[];
	lastCtrlCTime: number;
	toolsExpanded: boolean;
	stopped: boolean;
	shuttingDown: boolean;
}

export function createDPiConnectClientState(): DPiConnectClientState {
	return {
		errors: [],
		turnStatusEntries: [],
		lastCtrlCTime: 0,
		toolsExpanded: false,
		stopped: false,
		shuttingDown: false,
	};
}

function formatDPiConnectKeyText(key: string): string {
	return key
		.split("/")
		.map((candidate) =>
			candidate
				.split("+")
				.map((part) => (process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
				.join("+"),
		)
		.join("/");
}

function dPiConnectKeyText(keybinding: "app.interrupt"): string {
	return formatDPiConnectKeyText(getKeybindings().getKeys(keybinding).join("/"));
}

const DPI_CONNECT_FALLBACK_SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name", argumentHint: "<session-name>" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
];

class DPiConnectSelectComponent extends Container {
	private readonly list: SelectList;

	constructor(title: string, list: SelectList, theme: DPiNativeTheme) {
		super();
		this.list = list;
		this.addChild(new DPiNativeDynamicBorder((text) => theme.fg("borderMuted", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "↑↓ navigate  enter select  esc cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DPiNativeDynamicBorder((text) => theme.fg("borderMuted", text)));
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

class DPiConnectPanelComponent extends Container {
	private readonly onCancel: () => void;

	constructor(title: string, body: string, theme: DPiNativeTheme, onCancel: () => void) {
		super();
		this.onCancel = onCancel;
		this.addChild(new DPiNativeDynamicBorder((text) => theme.fg("borderMuted", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		for (const line of body.split("\n")) {
			this.addChild(new Text(line, 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "esc close"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DPiNativeDynamicBorder((text) => theme.fg("borderMuted", text)));
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			this.onCancel();
		}
	}
}

function restoreDPiConnectEditor(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
}): void {
	options.editorContainer.clear();
	options.editorContainer.addChild(options.editor);
	options.tui.setFocus(options.editor);
	options.tui.requestRender();
}

function showDPiConnectSelectInEditorSlot(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	title: string;
	items: SelectItem[];
	emptyStatus: string;
	showStatus(text: string): void;
	onSelect(item: SelectItem): void | Promise<void>;
}): void {
	if (options.items.length === 0) {
		options.showStatus(options.emptyStatus);
		return;
	}
	const list = new SelectList(options.items, 12, getDPiNativeSelectListTheme(options.theme), {
		maxPrimaryColumnWidth: 72,
	});
	const selector = new DPiConnectSelectComponent(options.title, list, options.theme);
	const restoreEditor = () => restoreDPiConnectEditor(options);
	options.editorContainer.clear();
	options.editorContainer.addChild(selector);
	options.tui.setFocus(selector);
	options.tui.requestRender();
	list.onCancel = restoreEditor;
	list.onSelect = (item) => {
		restoreEditor();
		void options.onSelect(item);
	};
}

function dPiConnectAgentStatusIndicator(status: AgentStatus): string {
	switch (status) {
		case "busy":
			return "●";
		case "starting":
			return "◌";
		case "error":
			return "✕";
		default:
			return "○";
	}
}

function formatDPiConnectAgentSelectLabel(
	agent: TeamAgentEntry,
	depth: number,
	isLast: boolean,
	isCurrent: boolean,
): string {
	let indent = "";
	if (depth > 0) {
		indent = "│ ".repeat(depth - 1);
		indent += isLast ? "└ " : "├ ";
	}
	const current = isCurrent ? " ◀" : "";
	return `${indent}${dPiConnectAgentStatusIndicator(agent.status)} ${agent.name}${current}`;
}

export function extractDPiConnectSelectedAgentName(value: string): string | undefined {
	return value.trim() || undefined;
}

export function buildDPiConnectAgentSelectItems(
	team: TeamSnapshot,
	currentAgentName: string | undefined,
): SelectItem[] {
	const agentMap = new Map(team.agents.map((agent) => [agent.name, agent]));
	const items: SelectItem[] = [];
	const visited = new Set<string>();
	const visit = (agent: TeamAgentEntry, depth: number, isLast: boolean): void => {
		visited.add(agent.name);
		items.push({
			value: agent.name,
			label: formatDPiConnectAgentSelectLabel(agent, depth, isLast, agent.name === currentAgentName),
			description: agent.parentName ? `parent: ${agent.parentName}` : "root",
		});
		for (let index = 0; index < agent.children.length; index++) {
			const child = agentMap.get(agent.children[index]!);
			if (child) {
				visit(child, depth + 1, index === agent.children.length - 1);
			}
		}
	};
	const root = agentMap.get(team.rootName);
	if (root) {
		visit(root, 0, true);
	}
	for (const agent of team.agents) {
		if (!visited.has(agent.name)) {
			visit(agent, 0, true);
		}
	}
	return items;
}

export function createDPiConnectAutocompleteProvider(
	commands: readonly DPiInteractiveSlashCommand[],
	cwd: string,
): CombinedAutocompleteProvider {
	const byName = new Map<string, SlashCommand>();
	for (const command of DPI_CONNECT_FALLBACK_SLASH_COMMANDS) {
		byName.set(command.name, command);
	}
	for (const command of commands) {
		byName.set(command.name, {
			name: command.name,
			description: command.description,
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
		});
	}
	return new CombinedAutocompleteProvider([...byName.values()], cwd);
}

export async function setupDPiConnectAutocomplete(
	editor: DPiConnectAutocompleteEditor,
	proxy: DPiInteractiveAgentSessionProxy,
	cwd: string,
): Promise<void> {
	try {
		editor.setAutocompleteProvider(createDPiConnectAutocompleteProvider(await proxy.fetchCommands(), cwd));
	} catch {
		editor.setAutocompleteProvider(createDPiConnectAutocompleteProvider([], cwd));
	}
}

async function fetchDPiConnectTeam(
	hubUrl: string,
	headers: Readonly<Record<string, string>> | undefined,
	fetchFn: typeof fetch,
): Promise<TeamSnapshot> {
	const response = await fetchFn(`${hubUrl.replace(/\/+$/, "")}/_hub/team`, { headers });
	if (!response.ok) {
		throw new Error(`Failed to fetch team: ${response.status}`);
	}
	return (await response.json()) as TeamSnapshot;
}

async function fetchDPiConnectSources(
	hubUrl: string,
	headers: Readonly<Record<string, string>> | undefined,
	fetchFn: typeof fetch,
): Promise<SourceInfo[]> {
	const response = await fetchFn(`${hubUrl.replace(/\/+$/, "")}/_hub/sources`, { headers });
	if (!response.ok) {
		throw new Error(`Failed to fetch sources: ${response.status}`);
	}
	return (await response.json()) as SourceInfo[];
}

export async function showDPiConnectAgentSelector(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	hubUrl: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	currentAgentName?: string;
	showStatus(text: string): void;
	stop(): Promise<void>;
}): Promise<void> {
	try {
		const team = await fetchDPiConnectTeam(options.hubUrl, options.authHeaders, options.fetch ?? fetch);
		const items = buildDPiConnectAgentSelectItems(team, options.currentAgentName);
		if (items.length === 0) {
			options.showStatus("No agents in team");
			return;
		}
		const list = new SelectList(items, 12, getDPiNativeSelectListTheme(options.theme), {
			maxPrimaryColumnWidth: 72,
		});
		const selector = new DPiConnectSelectComponent(`Switch to agent (${items.length})`, list, options.theme);
		const restoreEditor = () => {
			options.editorContainer.clear();
			options.editorContainer.addChild(options.editor);
			options.tui.setFocus(options.editor);
			options.tui.requestRender();
		};
		options.editorContainer.clear();
		options.editorContainer.addChild(selector);
		options.tui.setFocus(selector);
		options.tui.requestRender();
		list.onCancel = () => {
			restoreEditor();
		};
		list.onSelect = (item) => {
			const agentName = extractDPiConnectSelectedAgentName(item.value);
			if (!agentName) {
				return;
			}
			writeFileSync(AGENT_SWITCH_FILE, agentName, "utf-8");
			restoreEditor();
			void options.stop();
		};
	} catch (error) {
		options.showStatus(error instanceof Error ? error.message : String(error));
	}
}

export async function showDPiConnectSourcesSelector(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	hubUrl: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	showStatus(text: string): void;
}): Promise<void> {
	try {
		const sources = await fetchDPiConnectSources(options.hubUrl, options.authHeaders, options.fetch ?? fetch);
		if (sources.length === 0) {
			options.showStatus("No sources registered. Use set_source tool to register one.");
			return;
		}
		const items: SelectItem[] = sources.map((source) => ({
			value: source.name,
			label: `${source.name} [${source.status}]`,
			description: `command="${[source.command, ...source.args].join(" ")}" subscribers=${source.subscribers.join(",")}`,
		}));
		const list = new SelectList(items, 12, getDPiNativeSelectListTheme(options.theme), {
			maxPrimaryColumnWidth: 40,
		});
		const selector = new DPiConnectSelectComponent(`Sources (${items.length})`, list, options.theme);
		const restoreEditor = () => {
			options.editorContainer.clear();
			options.editorContainer.addChild(options.editor);
			options.tui.setFocus(options.editor);
			options.tui.requestRender();
		};
		options.editorContainer.clear();
		options.editorContainer.addChild(selector);
		options.tui.setFocus(selector);
		options.tui.requestRender();
		list.onCancel = () => {
			restoreEditor();
		};
		list.onSelect = () => {
			restoreEditor();
		};
	} catch (error) {
		options.showStatus(error instanceof Error ? error.message : String(error));
	}
}

export function showDPiConnectSettingsSelector(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	proxy: DPiInteractiveAgentSessionProxy;
	showStatus(text: string): void;
}): void {
	const settings = options.proxy.getSnapshot().remoteSettings;
	const items = buildSettingsSelectItems(settings);
	showDPiConnectSelectInEditorSlot({
		...options,
		title: "Settings",
		items,
		emptyStatus: "No settings available",
		onSelect: (item) => {
			const update = settingUpdateFromSelectValue(item.value, settings);
			if (update) {
				options.proxy.updateSettings(update);
				options.showStatus("Settings updated");
			}
		},
	});
}

export async function showDPiConnectForkSelector(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	proxy: DPiInteractiveAgentSessionProxy;
	showStatus(text: string): void;
}): Promise<void> {
	try {
		const messages = await options.proxy.fetchUserMessagesForForking();
		showDPiConnectSelectInEditorSlot({
			...options,
			title: "Fork from Message",
			items: messages.map(userMessageToSelectItem),
			emptyStatus: "No user messages found",
			onSelect: (item) => {
				void options.proxy.fork(item.value);
			},
		});
	} catch (error) {
		options.showStatus(error instanceof Error ? error.message : String(error));
	}
}

export async function showDPiConnectTreeSelector(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	proxy: DPiInteractiveAgentSessionProxy;
	showStatus(text: string): void;
}): Promise<void> {
	try {
		const tree = await options.proxy.fetchTree();
		const items = flattenTreeSelectItems(tree);
		showDPiConnectSelectInEditorSlot({
			...options,
			title: "Session Tree",
			items,
			emptyStatus: "No session tree entries",
			onSelect: (item) => {
				void options.proxy.fork(item.value);
			},
		});
	} catch (error) {
		options.showStatus(error instanceof Error ? error.message : String(error));
	}
}

export async function showDPiConnectResumeSelector(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	proxy: DPiInteractiveAgentSessionProxy;
	showStatus(text: string): void;
}): Promise<void> {
	try {
		const sessions = await options.proxy.getSessions();
		showDPiConnectSelectInEditorSlot({
			...options,
			title: `Resume Session (${sessions.length})`,
			items: sessions.map(sessionToSelectItem),
			emptyStatus: "No sessions found",
			onSelect: (item) => {
				void options.proxy.switchSession(item.value);
			},
		});
	} catch (error) {
		options.showStatus(error instanceof Error ? error.message : String(error));
	}
}

export function showDPiConnectPanel(options: {
	tui: TUI;
	editor: DPiNativeCustomEditor;
	editorContainer: Container;
	theme: DPiNativeTheme;
	title: string;
	body: string;
}): void {
	const panel = new DPiConnectPanelComponent(options.title, options.body, options.theme, () =>
		restoreDPiConnectEditor(options),
	);
	options.editorContainer.clear();
	options.editorContainer.addChild(panel);
	options.tui.setFocus(panel);
	options.tui.requestRender();
}

function userMessageToSelectItem(message: DPiInteractiveUserMessageItem): SelectItem {
	return {
		value: message.id,
		label: message.text.replace(/\s+/g, " ").trim() || "(empty message)",
		description: message.id,
	};
}

function sessionToSelectItem(session: DPiInteractiveSessionItemData): SelectItem {
	return {
		value: session.path,
		label: session.name ?? (session.firstMessage.replace(/\s+/g, " ").trim() || session.id),
		description: `${session.cwd} · ${session.messageCount} messages · ${session.modified}`,
	};
}

function flattenTreeSelectItems(tree: DPiInteractiveTreeNodeData[]): SelectItem[] {
	const items: SelectItem[] = [];
	const visit = (node: DPiInteractiveTreeNodeData, depth: number, isLast: boolean): void => {
		const indent = depth === 0 ? "" : `${"│ ".repeat(Math.max(0, depth - 1))}${isLast ? "└ " : "├ "}`;
		items.push({
			value: node.id,
			label: `${indent}${node.type}: ${node.preview ?? node.label ?? node.id}`,
			description: node.timestamp,
		});
		for (let index = 0; index < node.children.length; index++) {
			visit(node.children[index]!, depth + 1, index === node.children.length - 1);
		}
	};
	for (let index = 0; index < tree.length; index++) {
		visit(tree[index]!, 0, index === tree.length - 1);
	}
	return items;
}

function buildSettingsSelectItems(settings: DPiInteractiveRemoteSettings): SelectItem[] {
	return [
		{
			value: "autoCompact",
			label: `Auto-compact: ${settings.autoCompact ? "on" : "off"}`,
			description: "Automatically compact context when it gets too large",
		},
		{
			value: "steeringMode",
			label: `Steering mode: ${settings.steeringMode}`,
			description: "How steering messages are delivered while streaming",
		},
		{
			value: "followUpMode",
			label: `Follow-up mode: ${settings.followUpMode}`,
			description: "How follow-up messages are delivered",
		},
		...settings.availableThinkingLevels.map((level) => ({
			value: `thinking:${level}`,
			label: `Thinking: ${level}${settings.thinkingLevel === level ? " ✓" : ""}`,
			description: "Set reasoning effort",
		})),
	];
}

function settingUpdateFromSelectValue(
	value: string,
	settings: DPiInteractiveRemoteSettings,
): Record<string, unknown> | undefined {
	if (value === "autoCompact") {
		return { autoCompact: !settings.autoCompact };
	}
	if (value === "steeringMode") {
		return { steeringMode: settings.steeringMode === "all" ? "one-at-a-time" : "all" };
	}
	if (value === "followUpMode") {
		return { followUpMode: settings.followUpMode === "all" ? "one-at-a-time" : "all" };
	}
	if (value.startsWith("thinking:")) {
		return { thinkingLevel: value.slice("thinking:".length) };
	}
	return undefined;
}

function sessionPanelText(snapshot: DPiInteractiveSessionStateSnapshot): string {
	return [
		`Session: ${snapshot.sessionName ?? snapshot.sessionFile ?? "(unnamed)"}`,
		`Path: ${snapshot.sessionFile ?? "(none)"}`,
		`CWD: ${snapshot.cwd}`,
		`Model: ${snapshot.model}`,
		`Thinking: ${snapshot.thinkingLevel}`,
		`Messages: ${snapshot.messages.length}`,
		`Context: ${snapshot.contextUsage.tokens ?? "?"}/${snapshot.contextUsage.contextWindow}`,
	].join("\n");
}

function hotkeysPanelText(): string {
	return [
		"escape interrupt/cancel",
		"ctrl+c clear; ctrl+c twice exit",
		"ctrl+d exit when editor is empty",
		"shift+tab cycle thinking level",
		"ctrl+o expand tools",
		"ctrl+t expand thinking",
		"ctrl+g external editor",
		"alt+enter queue follow-up",
		"alt+up edit all queued messages",
		"/ open commands",
		"! run bash (not available in connect mode)",
	].join("\n");
}

export async function handleDPiConnectSlashCommand(
	text: string,
	handlers: DPiConnectSlashCommandHandlers,
): Promise<boolean> {
	if (!text.startsWith("/")) {
		return false;
	}
	const command = text.split(" ")[0] ?? text;
	const arg = text.slice(command.length + 1).trim() || undefined;
	const {
		proxy,
		copyLastAssistantMessage,
		refreshAutocomplete,
		showAgentSelector,
		showChangelog,
		showForkSelector,
		showHotkeys,
		showResumeSelector,
		showSessionInfo,
		showSettingsSelector,
		showSourcesSelector,
		showStatus,
		showTreeSelector,
		stop,
	} = {
		...handlers,
		showChangelog: handlers.showPanel
			? () =>
					handlers.showPanel?.(
						"Changelog",
						handlers.proxy.getSnapshot().banner?.changelogMarkdown ?? "No changelog available",
					)
			: undefined,
		showHotkeys: handlers.showPanel ? () => handlers.showPanel?.("Hotkeys", hotkeysPanelText()) : undefined,
		showSessionInfo: handlers.showPanel
			? () => handlers.showPanel?.("Session", sessionPanelText(handlers.proxy.getSnapshot()))
			: undefined,
	};
	try {
		switch (command) {
			case "/settings":
				if (showSettingsSelector) {
					await showSettingsSelector();
				} else {
					showStatus("Settings selector not available in d-pi connect");
				}
				return true;
			case "/agents":
				if (showAgentSelector) {
					await showAgentSelector();
				} else {
					showStatus("Agent selector not available in d-pi connect");
				}
				return true;
			case "/sources":
				if (showSourcesSelector) {
					await showSourcesSelector();
				} else {
					showStatus("Sources selector not available in d-pi connect");
				}
				return true;
			case "/quit":
				await stop();
				return true;
			case "/compact":
				await proxy.compact();
				return true;
			case "/copy":
				if (copyLastAssistantMessage) {
					await copyLastAssistantMessage();
				} else {
					showStatus("Copy not available in d-pi connect");
				}
				return true;
			case "/session":
				showSessionInfo?.();
				return true;
			case "/changelog":
				showChangelog?.();
				return true;
			case "/hotkeys":
				showHotkeys?.();
				return true;
			case "/fork":
				if (showForkSelector) {
					await showForkSelector();
				} else {
					showStatus("Fork selector not available in d-pi connect");
				}
				return true;
			case "/new":
				await proxy.newSession();
				return true;
			case "/clone":
				await proxy.fork();
				return true;
			case "/tree":
				if (showTreeSelector) {
					await showTreeSelector();
				} else {
					showStatus("Tree selector not available in d-pi connect");
				}
				return true;
			case "/resume":
				if (showResumeSelector) {
					await showResumeSelector();
				} else {
					showStatus("Session selector not available in d-pi connect");
				}
				return true;
			case "/name":
				if (arg) {
					proxy.renameSession(arg);
					showStatus(`Session renamed to: ${arg}`);
				} else {
					showStatus("Usage: /name <session-name>");
				}
				return true;
			case "/reload":
				await proxy.reload();
				await refreshAutocomplete?.();
				showStatus("Reloaded");
				return true;
			case "/export":
			case "/import":
			case "/share":
				showStatus("Not available in connect mode");
				return true;
			case "/login":
			case "/logout":
				showStatus("Not available in connect mode — configure auth on the server");
				return true;
			default:
				return false;
		}
	} catch (error) {
		showStatus(error instanceof Error ? error.message : String(error));
		return true;
	}
}

export function handleDPiConnectBashInput(text: string, showStatus: (text: string) => void): boolean {
	const trimmed = text.trim();
	if (trimmed === "!" || trimmed.startsWith("! ")) {
		showStatus("Not available in connect mode");
		return true;
	}
	if (trimmed === "!!" || trimmed.startsWith("!! ")) {
		showStatus("Not available in connect mode");
		return true;
	}
	return false;
}

export function recordDPiConnectPromptHistory(editor: DPiConnectHistoryEditor, text: string): void {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) {
		return;
	}
	editor.addToHistory?.(trimmed);
}

export async function runDPiConnectInteractiveMode(
	options: RunDPiConnectInteractiveModeOptions,
): Promise<DPiConnectInteractiveModeHandle> {
	void options.hubUrl;
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal);
	const nativeTheme = createDPiNativeTheme({ color: true });
	const keybindings = createDPiNativeKeybindings();
	setKeybindings(keybindings);
	const banner = new Text("", 0, 0);
	const messages = new Container();
	const status = new DPiNativeStatusContainer(tui, nativeTheme);
	const footer = new Text("", 0, 0);
	const editor = new DPiNativeCustomEditor(tui, getDPiNativeEditorTheme(nativeTheme), keybindings);
	const layout = createDPiConnectRootLayout();
	const { editorContainer, pendingMessagesContainer } = layout;
	editorContainer.addChild(editor);
	layout.headerContainer.addChild(banner);
	layout.chatContainer.addChild(messages);
	layout.statusContainer.addChild(status);
	layout.widgetContainerAbove.addChild(new Spacer(1));
	layout.footerContainer.addChild(footer);
	tui.addChild(layout.root);
	tui.setFocus(editor);

	const proxy =
		options.proxy ??
		(await createDPiInteractiveRemoteAgentSessionProxy({
			baseUrl: options.agentUrl,
			headers: options.authHeaders,
			fetch: options.fetch,
		}));
	void setupDPiConnectAutocomplete(editor, proxy, process.cwd());
	const clientState = createDPiConnectClientState();
	const gitBranch = options.gitBranch ?? readDPiConnectGitBranch(process.cwd());
	const stop = async (): Promise<void> => {
		if (clientState.stopped) {
			return;
		}
		clientState.stopped = true;
		unsubscribe();
		unsubscribeStatus();
		status.dispose();
		proxy.disconnect?.();
		terminal.setProgress(false);
		tui.stop();
	};
	const shutdown = async (): Promise<void> => {
		if (clientState.shuttingDown) {
			return;
		}
		clientState.shuttingDown = true;
		await terminal.drainInput(1000);
		await stop();
		(options.exit ?? process.exit)(0);
	};

	const render = () => {
		const snapshot = proxy.getSnapshot();
		const messageSnapshot = createDPiConnectMessageSnapshot(snapshot);
		const footerSnapshot = createDPiConnectFooterSnapshot(snapshot, process.cwd(), process.env);
		banner.setText(
			buildDPiInteractiveBannerView(createDPiConnectStartupBanner(process.cwd(), snapshot.banner), {
				color: true,
				expanded: clientState.toolsExpanded,
			}).text,
		);
		const errorText =
			clientState.errors.length === 0
				? ""
				: `\n\nErrors:\n${clientState.errors.map((error) => `- ${error}`).join("\n")}`;
		messages.clear();
		messages.addChild(
			buildDPiInteractiveMessageListComponent(messageSnapshot, {
				color: true,
				statusEntries: clientState.turnStatusEntries,
				cwd: process.cwd(),
				toolsExpanded: clientState.toolsExpanded,
			}),
		);
		if (errorText) {
			messages.addChild(new Text(errorText, 1, 0));
		}
		pendingMessagesContainer.clear();
		pendingMessagesContainer.addChild(buildDPiInteractivePendingMessagesComponent(snapshot, { color: true }));
		status.setWorking(
			snapshot.isStreaming || snapshot.isBashRunning || snapshot.isCompacting,
			snapshot.isCompacting
				? `Compacting context... (${dPiConnectKeyText("app.interrupt")} to cancel)`
				: "Working...",
		);
		footer.setText(
			buildDPiInteractiveFooterView({
				snapshot: footerSnapshot,
				gitBranch,
				width: terminal.columns,
				showThinkingLevel: false,
				color: true,
			}).text,
		);
		terminal.setProgress(snapshot.isStreaming || snapshot.isBashRunning || snapshot.isCompacting);
		tui.requestRender();
	};
	const showChatStatus = (text: string): void => {
		const afterMessageCount = proxy.getSnapshot().messages.length;
		const last = clientState.turnStatusEntries[clientState.turnStatusEntries.length - 1];
		if (last?.afterMessageCount === afterMessageCount) {
			last.text = text;
		} else {
			clientState.turnStatusEntries.push({ afterMessageCount, text });
		}
		render();
	};
	const showAgentSelector = async (): Promise<void> => {
		await showDPiConnectAgentSelector({
			tui,
			editor,
			editorContainer,
			theme: nativeTheme,
			hubUrl: options.hubUrl,
			authHeaders: options.authHeaders,
			fetch: options.fetch,
			currentAgentName: new URL(options.agentUrl).pathname.split("/").filter(Boolean).map(decodeURIComponent).at(-1),
			showStatus: showChatStatus,
			stop: shutdown,
		});
	};
	const showSourcesSelector = async (): Promise<void> => {
		await showDPiConnectSourcesSelector({
			tui,
			editor,
			editorContainer,
			theme: nativeTheme,
			hubUrl: options.hubUrl,
			authHeaders: options.authHeaders,
			fetch: options.fetch,
			showStatus: showChatStatus,
		});
	};
	const showSettingsSelector = async (): Promise<void> => {
		showDPiConnectSettingsSelector({
			tui,
			editor,
			editorContainer,
			theme: nativeTheme,
			proxy,
			showStatus: showChatStatus,
		});
	};
	const showForkSelector = async (): Promise<void> => {
		await showDPiConnectForkSelector({
			tui,
			editor,
			editorContainer,
			theme: nativeTheme,
			proxy,
			showStatus: showChatStatus,
		});
	};
	const showTreeSelector = async (): Promise<void> => {
		await showDPiConnectTreeSelector({
			tui,
			editor,
			editorContainer,
			theme: nativeTheme,
			proxy,
			showStatus: showChatStatus,
		});
	};
	const showResumeSelector = async (): Promise<void> => {
		await showDPiConnectResumeSelector({
			tui,
			editor,
			editorContainer,
			theme: nativeTheme,
			proxy,
			showStatus: showChatStatus,
		});
	};
	const showPanel = (title: string, body: string): void => {
		showDPiConnectPanel({ tui, editor, editorContainer, theme: nativeTheme, title, body });
	};
	const copyLastAssistantMessage = async (): Promise<void> => {
		const message = [...proxy.getSnapshot().messages].reverse().find((entry) => entry.role === "assistant");
		const content = typeof message?.content === "string" ? message.content : undefined;
		if (!content) {
			showChatStatus("No assistant message to copy");
			return;
		}
		try {
			execFileSync("pbcopy", [], { input: content });
			showChatStatus("Copied last assistant message");
		} catch {
			showChatStatus("Copy not available in this terminal");
		}
	};
	const refreshAutocomplete = async (): Promise<void> => {
		await setupDPiConnectAutocomplete(editor, proxy, process.cwd());
	};
	const unsubscribe = proxy.subscribe(render);
	const unsubscribeStatus = proxy.subscribe((event) => {
		if (event.type === "session_replaced") {
			clientState.turnStatusEntries.splice(0, clientState.turnStatusEntries.length);
			render();
			return;
		}
		if (event.type === "turn_stats") {
			const text = buildDPiInteractiveStatusView({ isStreaming: false }, event, { color: false }).text;
			showChatStatus(text);
		}
	});
	editor.onSubmit = (text) => {
		const trimmed = text.trim();
		if (handleDPiConnectBashInput(trimmed, showChatStatus)) {
			editor.setText("");
			render();
			return;
		}
		if (trimmed.startsWith("/")) {
			editor.setText("");
			render();
			void handleDPiConnectSlashCommand(trimmed, {
				proxy,
				showAgentSelector,
				showSourcesSelector,
				showSettingsSelector,
				showForkSelector,
				showTreeSelector,
				showResumeSelector,
				showPanel,
				copyLastAssistantMessage,
				refreshAutocomplete,
				showStatus: showChatStatus,
				stop: shutdown,
			}).then((handled) => {
				if (!handled) {
					void submitDPiInteractiveEditorText(proxy, trimmed, (error) => {
						clientState.errors.push(error instanceof Error ? error.message : String(error));
						render();
					});
				}
			});
			return;
		}
		recordDPiConnectPromptHistory(editor, text);
		void submitDPiInteractiveEditorText(proxy, text, (error) => {
			clientState.errors.push(error instanceof Error ? error.message : String(error));
			render();
		});
	};
	editor.onEscape = () => proxy.abort();
	editor.onAction("app.clear", () => {
		const now = Date.now();
		if (now - clientState.lastCtrlCTime < 500) {
			void shutdown();
			return;
		}
		editor.setText("");
		clientState.lastCtrlCTime = now;
		status.showStatus("Press ctrl+c again to exit");
		render();
	});
	editor.onCtrlD = () => {
		void shutdown();
	};
	editor.onAction("app.message.followUp", () => {
		const text = editor.getText().trim();
		if (!text) {
			return;
		}
		editor.addToHistory?.(text);
		editor.setText("");
		proxy.followUp(text);
	});
	editor.onAction("app.message.dequeue", () => {
		const dropped = proxy.clearQueue();
		const text = [...dropped.steering, ...dropped.followUp].join("\n");
		if (text) {
			editor.setText(text);
		}
	});
	editor.onAction("app.thinking.cycle", () => {
		proxy.cycleThinkingLevel(1);
	});
	editor.onAction("app.thinking.toggle", () => {
		proxy.updateSettings({ hideThinkingBlock: !proxy.getSnapshot().remoteSettings.hideThinkingBlock });
	});
	editor.onAction("app.session.new", () => {
		void proxy.newSession();
	});
	editor.onAction("app.session.tree", () => {
		void showTreeSelector();
	});
	editor.onAction("app.session.fork", () => {
		void showForkSelector();
	});
	editor.onAction("app.session.resume", () => {
		void showResumeSelector();
	});
	editor.onAction("app.tools.expand", () => {
		clientState.toolsExpanded = !clientState.toolsExpanded;
		render();
	});
	editor.onAction("app.editor.external", () => {
		showChatStatus("External editor not available in d-pi connect");
	});
	editor.onPasteImage = () => {
		showChatStatus("Paste image not available in d-pi connect");
	};

	await proxy.connect?.();
	render();
	tui.start();

	const handle: DPiConnectInteractiveModeHandle = {
		tui,
		proxy,
		stop,
	};
	return handle;
}

export function createDPiConnectFooterSnapshot(
	snapshot: DPiInteractiveAgentSessionProxy["getSnapshot"] extends () => infer T ? T : never,
	localCwd: string,
	env: DPiConnectStartupBannerEnv = {},
): ReturnType<DPiInteractiveAgentSessionProxy["getSnapshot"]> {
	return { ...snapshot, cwd: displayPath(localCwd, env.HOME) };
}

export function createDPiConnectMessageSnapshot(
	snapshot: DPiInteractiveSessionStateSnapshot,
): DPiInteractiveSessionStateSnapshot {
	return snapshot;
}

export function normalizeDPiConnectGitBranch(output: string): string | null {
	const branch = output.trim();
	return branch.length === 0 ? null : branch;
}

export function createDPiConnectStartupBanner(
	localCwd: string,
	remoteBanner: DPiInteractiveBannerData | undefined,
	env: DPiConnectStartupBannerEnv = process.env,
): DPiInteractiveBannerData {
	const nativeBase = createNativePiBannerBase(env);
	const remoteExtraResources = remoteBanner?.loadedResources ?? [];
	const remoteExtraDiagnostics = remoteBanner?.diagnostics ?? [];
	const contextResources = collectLocalAgentsFiles(localCwd, env.HOME);
	const skillResources = collectLocalSkills(env.HOME);
	const loadedResources = [
		...(contextResources.length > 0
			? [
					{
						name: "Context",
						compactList: contextResources.join(", "),
						expandedList: contextResources.join("\n"),
					},
				]
			: []),
		...(skillResources.skills.length > 0
			? [
					{
						name: "Skills",
						compactList: skillResources.skills.map((skill) => skill.name).join(", "),
						expandedList: skillResources.skills.map((skill) => skill.path).join("\n"),
					},
				]
			: []),
		...remoteExtraResources.filter((resource) => resource.name !== "Context" && resource.name !== "Skills"),
	];
	return {
		...nativeBase,
		appName: "pi",
		version: env.DPI_NATIVE_PI_VERSION ?? nativeBase.version,
		loadedResources,
		diagnostics: [...skillResources.diagnostics, ...remoteExtraDiagnostics],
		changelogMarkdown: nativePiStartupNotices(),
	};
}

function createNativePiBannerBase(env: DPiConnectStartupBannerEnv): DPiInteractiveBannerData {
	return {
		appName: "pi",
		version: env.DPI_NATIVE_PI_VERSION ?? "0.79.6",
		expandedHints: [
			{ key: "escape", description: "to interrupt" },
			{ key: "ctrl+c", description: "to clear" },
			{ key: "ctrl+c twice", description: "to exit" },
			{ key: "ctrl+d", description: "to exit (empty)" },
			{ key: "ctrl+z", description: "to suspend" },
			{ key: "ctrl+k", description: "to delete to end" },
			{ key: "shift+tab", description: "to cycle thinking level" },
			{ key: "ctrl+o", description: "to expand tools" },
			{ key: "ctrl+t", description: "to expand thinking" },
			{ key: "ctrl+g", description: "for external editor" },
			{ key: "/", description: "for commands" },
			{ key: "!", description: "to run bash" },
			{ key: "!!", description: "to run bash (no context)" },
			{ key: "alt+enter", description: "to queue follow-up" },
			{ key: "alt+up", description: "to edit all queued messages" },
			{ key: "ctrl+v", description: "to paste image" },
			{ key: "drop files", description: "to attach" },
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
		loadedResources: [],
		diagnostics: [],
		changelogMarkdown: undefined,
	};
}

function nativePiStartupNotices(): string {
	const separator = "─".repeat(120);
	return [
		"",
		" Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf",
		" and restart tmux.",
		"",
		separator,
		" Update Available",
		" New version 0.79.7 is available. Run pi update",
		" Changelog: https://pi.dev/changelog",
		separator,
		"",
	].join("\n");
}

function collectLocalAgentsFiles(localCwd: string, home: string | undefined): string[] {
	const resolvedCwd = resolve(localCwd);
	const paths: string[] = [];
	let current = resolvedCwd;
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) {
			paths.push(candidate);
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return paths.reverse().map((path) => displayPath(path, home));
}

interface LocalSkillEntry {
	name: string;
	path: string;
	source: string;
}

function collectLocalSkills(home: string | undefined): {
	skills: LocalSkillEntry[];
	diagnostics: DPiInteractiveBannerData["diagnostics"];
} {
	if (!home) {
		return { skills: [], diagnostics: [] };
	}
	const roots = [{ source: "user", path: join(home, ".agents", "skills") }];
	const candidates = roots.flatMap((root) => collectSkillFiles(root.path, root.source, home));
	const byName = new Map<string, LocalSkillEntry[]>();
	for (const candidate of candidates) {
		const existing = byName.get(candidate.name);
		if (existing) {
			existing.push(candidate);
		} else {
			byName.set(candidate.name, [candidate]);
		}
	}
	const skills: LocalSkillEntry[] = [];
	const diagnostics: DPiInteractiveBannerData["diagnostics"][number]["entries"] = [];
	for (const [name, entries] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const [winner, ...losers] = entries.sort((left, right) => skillPriority(left) - skillPriority(right));
		if (!winner) {
			continue;
		}
		skills.push(winner);
		for (const loser of losers) {
			diagnostics.push({
				type: "collision",
				message: `${name} skill collision`,
				collision: {
					resourceType: "skill",
					name,
					winnerPath: winner.path,
					loserPath: loser.path,
					winnerSource: winner.source,
				},
			});
		}
	}
	return {
		skills,
		diagnostics: diagnostics.length === 0 ? [] : [{ label: "Skill conflicts", entries: diagnostics }],
	};
}

function collectSkillFiles(root: string, source: string, home: string): LocalSkillEntry[] {
	if (!existsSync(root)) {
		return [];
	}
	const entries: LocalSkillEntry[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isFile() && entry.name === "SKILL.md") {
				const skillName = skillNameFromFile(path) ?? dirname(path).split("/").at(-1) ?? dirname(path);
				entries.push({
					name: skillName,
					path: displayPath(path, home),
					source,
				});
				continue;
			}
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				walk(path);
			}
		}
	};
	walk(root);
	return entries;
}

function skillPriority(skill: LocalSkillEntry): number {
	return skill.path.includes("/superpowers/") ? 0 : 1;
}

function skillNameFromFile(path: string): string | undefined {
	try {
		const firstLines = readFileSync(path, "utf8").split("\n").slice(0, 8).join("\n");
		const match = /^name:\s*(.+)$/m.exec(firstLines);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

function displayPath(path: string, home: string | undefined): string {
	const resolved = resolve(path);
	const resolvedHome = home ? resolve(home) : undefined;
	if (resolvedHome && (resolved === resolvedHome || resolved.startsWith(`${resolvedHome}/`))) {
		return `~${resolved.slice(resolvedHome.length)}`;
	}
	return resolved;
}

function readDPiConnectGitBranch(cwd: string): string | null {
	try {
		return normalizeDPiConnectGitBranch(
			execFileSync("git", ["branch", "--show-current"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch {
		return null;
	}
}
