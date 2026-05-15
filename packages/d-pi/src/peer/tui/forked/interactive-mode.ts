import { basename } from "node:path";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Loader,
	ProcessTerminal,
	type SlashCommand,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
} from "@sheason/pi-tui";
import type { MessageSource } from "../../../hub/agent/types.js";
import type { HubSkillDiagnostic, HubSkillInfo, McpRuntimeStatus, SourceRuntimeStatus } from "../../../hub/index.js";
import { type PeerCommandParseResult, parsePeerCommand } from "../../commands/index.js";
import type { PeerThinkingLevel } from "../../types.js";
import {
	AssistantMessageComponent,
	CustomEditor,
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	KeybindingsManager,
	ToolExecutionComponent,
	theme,
	UserMessageComponent,
} from "../components/index.js";
import type { RemoteInteractiveActions } from "../interactive/remote-interactive-actions.js";
import type { RemoteInteractiveCapabilities } from "../interactive/remote-interactive-capabilities.js";
import type {
	RemoteInteractiveGroupAgentView,
	RemoteInteractiveSessionView,
	RemoteInteractiveView,
} from "../interactive/remote-interactive-view.js";
import { RemoteAgentSelectorComponent } from "./components/agent-selector.js";
import { ForkedFooterComponent } from "./components/footer.js";
import { buildForkedStartupHelp, keyText } from "./components/keybinding-hints.js";
import { type McpDetailAction, RemoteMcpDetailSelectorComponent } from "./components/mcp-detail-selector.js";
import { RemoteMcpListSelectorComponent } from "./components/mcp-list-selector.js";
import { RemoteModelSelectorComponent } from "./components/model-selector.js";
import { RemoteSettingsSelectorComponent } from "./components/settings-selector.js";
import { RemoteSkillDetailSelectorComponent } from "./components/skill-detail-selector.js";
import { RemoteSkillListSelectorComponent } from "./components/skill-list-selector.js";
import { RemoteSourceDetailSelectorComponent, type SourceDetailAction } from "./components/source-detail-selector.js";
import { RemoteSourceListSelectorComponent } from "./components/source-list-selector.js";

const CONNECTION_RETRY_ACTION = "app.connection.retry" as Parameters<CustomEditor["onAction"]>[0];

declare module "@sheason/pi-tui" {
	interface Keybindings {
		"app.connection.retry": true;
	}
}

type PeerItem = NonNullable<RemoteInteractiveSessionView["items"]>[number];
type PeerMessage = Extract<PeerItem, { type: "message" }>["message"];
type AssistantPeerMessage = Extract<PeerMessage, { role: "assistant" }>;
type ToolResultPeerMessage = Extract<PeerMessage, { role: "toolResult" }>;
type LiveAssistantPeerMessage = NonNullable<NonNullable<RemoteInteractiveView["live"]>["streamingMessage"]>;
type LiveToolExecution = NonNullable<NonNullable<RemoteInteractiveView["live"]>["toolExecutions"]>[number];
type RenderedAssistantMessage = AssistantPeerMessage | LiveAssistantPeerMessage;
type AssistantToolCallContent = Extract<RenderedAssistantMessage["content"][number], { type: "toolCall" }>;
type UserPeerMessage = Extract<PeerMessage, { role: "user" }> & { messageSource?: MessageSource };
type AssistantComponentOptions = {
	liveComponentKey?: string;
	snapshotComponentKey?: string;
};
type IncrementalAssistantMessageComponent = {
	updateContent(message: RenderedAssistantMessage): void;
	tryUpdateContentIncrementally?(message: RenderedAssistantMessage): boolean;
};
type SelectorKind =
	| "model"
	| "agent-list"
	| "settings"
	| "source-list"
	| "source-detail"
	| "mcp-list"
	| "mcp-detail"
	| "skill-list"
	| "skill-detail";
type SelectorFactory = (done: () => void) => { component: Component; focus: Component };
type RemoteInteractiveViewSignatures = {
	layout: string;
	chat: string;
	liveText: string;
	queue: string;
	status: string;
	footer: string;
};
type RemoteInteractiveViewDirtyFlags = {
	layout: boolean;
	chat: boolean;
	liveText: boolean;
	queue: boolean;
	status: boolean;
	footer: boolean;
};

export interface ForkedInteractiveModeOptions {
	themeName?: string;
}

export interface ForkedInteractiveModeDeps {
	peerId: string;
	cwd: string;
	getView(): RemoteInteractiveView;
	actions: RemoteInteractiveActions;
	capabilities: RemoteInteractiveCapabilities;
	getDraft(): string;
	setDraft(draft: string): void;
	subscribe(listener: () => void): () => void;
}

function serverNameForResourceId(servers: McpRuntimeStatus[], resourceId: string): string | undefined {
	return servers.find((server) => server.resourceId === resourceId)?.name;
}

export class ForkedInteractiveMode {
	private readonly ui: TUI;
	private readonly root = new Container();
	private readonly headerContainer = new Container();
	private readonly chatContainer = new Container();
	private readonly pendingMessagesContainer = new Container();
	private readonly statusContainer = new Container();
	private readonly editorContainer = new Container();
	private readonly footer: ForkedFooterComponent;
	private readonly keybindings: KeybindingsManager;
	private readonly editor: CustomEditor;
	private readonly markdownTheme = getMarkdownTheme();
	private statusLoader: Loader | undefined;
	private statusLoaderMessage: string | undefined;
	private workingStatusTimer: ReturnType<typeof setInterval> | undefined;
	private workingStatusTimerStartedAt: string | undefined;
	private scheduledRender: ReturnType<typeof setImmediate> | undefined;
	private activeSelector: Component | undefined;
	activeSelectorKind: SelectorKind | undefined;
	private unsubscribers: Array<() => void> = [];
	private signalCleanupHandlers: Array<() => void> = [];
	private shutdownResolver: ((code: number) => void) | undefined;
	private isShuttingDown = false;
	private lastClearActionTime = 0;
	private currentSourceStatuses: SourceRuntimeStatus[] = [];
	private currentMcpServers: McpRuntimeStatus[] = [];
	private currentMcpConfigError: string | undefined;
	private currentSkills: HubSkillInfo[] = [];
	private currentSkillDiagnostics: HubSkillDiagnostic[] = [];
	private readonly userMessageComponents = new Map<
		string,
		{ text: string; messageSourceJson: string; component: UserMessageComponent }
	>();
	private readonly assistantMessageComponents = new Map<
		string,
		{ signature: string; component: AssistantMessageComponent }
	>();
	private readonly toolExecutionComponents = new Map<
		string,
		{ signature: string; component: ToolExecutionComponent }
	>();
	private readonly pendingMessageComponents = new Map<string, TruncatedText>();
	private lastRenderedSignatures: RemoteInteractiveViewSignatures | undefined;
	private liveAssistantComponent:
		| {
				key: string;
				component: AssistantMessageComponent;
		  }
		| undefined;

	constructor(
		private readonly deps: ForkedInteractiveModeDeps,
		options: ForkedInteractiveModeOptions = {},
	) {
		initTheme(options.themeName);
		this.ui = new TUI(new ProcessTerminal(), false);
		this.keybindings = KeybindingsManager.create();
		this.installPeerKeybindings();
		setKeybindings(this.keybindings);
		this.editor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: 1,
			autocompleteMaxVisible: 8,
		});
		this.editor.setAutocompleteProvider(this.createAutocompleteProvider());
		this.footer = new ForkedFooterComponent();
		this.installEditorHandlers();
		this.buildLayout();
	}

	private installPeerKeybindings(): void {
		const currentBindings = this.keybindings.getUserBindings();
		const newlineKeys = this.keybindings.getKeys("tui.input.newLine");
		const retryKeys = this.keybindings.getKeys("app.connection.retry");
		const hasConfiguredRetryKeys = Object.hasOwn(currentBindings, "app.connection.retry");
		if (newlineKeys.includes("ctrl+j") && (retryKeys.length > 0 || hasConfiguredRetryKeys)) {
			return;
		}
		this.keybindings.setUserBindings({
			...currentBindings,
			...(newlineKeys.includes("ctrl+j") ? {} : { "tui.input.newLine": [...newlineKeys, "ctrl+j"] }),
			...(retryKeys.length > 0 || hasConfiguredRetryKeys ? {} : { "app.connection.retry": ["ctrl+r"] }),
		});
	}

	async run(): Promise<number> {
		try {
			this.registerSignalHandlers();
			this.ui.start();
			this.subscribeToState();
			this.ui.terminal.setTitle(`D-Pi Peer - ${basename(this.deps.cwd || process.cwd())}`);
			this.renderFromState();
			this.ui.requestRender();
			return await new Promise<number>((resolve) => {
				this.shutdownResolver = resolve;
			});
		} catch (error) {
			this.ui.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.statusLoader?.stop();
		this.statusLoader = undefined;
		this.statusLoaderMessage = undefined;
		this.stopWorkingStatusTimer();
		this.cancelScheduledRender();
		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];
		this.unregisterSignalHandlers();
		await new Promise((resolve) => process.nextTick(resolve));
		await this.ui.terminal.drainInput(1000);
		this.ui.stop();
	}

	private buildLayout(): void {
		this.restoreEditor();
		this.root.addChild(this.headerContainer);
		this.root.addChild(this.chatContainer);
		this.root.addChild(this.pendingMessagesContainer);
		this.root.addChild(this.statusContainer);
		this.root.addChild(this.editorContainer);
		this.root.addChild(this.footer);
		this.ui.addChild(this.root);
		this.ui.setFocus(this.editor);
		this.renderStatusArea(this.deps.getView());
	}

	private installEditorHandlers(): void {
		this.editor.onSubmit = (text: string) => {
			void this.queueInput(text);
		};
		this.editor.onChange = (text: string) => {
			this.deps.setDraft(text);
		};
		this.editor.onEscape = () => {
			const session = this.deps.getView().session;
			if ((session?.queuedMessages?.length ?? 0) > 0) {
				void this.requireQueueFlush()();
				return;
			}
			if (session?.isRunning) {
				void this.deps.actions.abort();
				return;
			}
			if (this.editor.getText().length > 0) {
				this.deps.setDraft("");
				this.editor.setText("");
				this.ui.requestRender();
			}
		};
		this.editor.onCtrlD = () => {
			void this.shutdown();
		};
		this.editor.onAction("app.clear", () => {
			void this.handleClearAction();
		});
		this.editor.onAction("app.message.followUp", () => {
			void this.queueInput(this.editor.getText());
		});
		this.editor.onAction("app.message.dequeue", () => {
			void this.handleDequeue();
		});
		this.editor.onAction(CONNECTION_RETRY_ACTION, () => {
			void this.deps.actions.retryConnection?.();
		});
		this.editor.onAction("app.model.select", () => {
			if (!this.deps.capabilities.supportsModelSelection) {
				this.appendWarningMessage('"/model" is disabled in this remote mode.');
				return;
			}
			this.openModelSelector();
		});
	}

	private subscribeToState(): void {
		this.unsubscribers.push(
			this.deps.subscribe(() => {
				const view = this.deps.getView();
				const dirtyFlags = this.computeRenderDirtyFlags(this.lastRenderedSignatures, view);
				if (this.canRenderDirtyStateDirectly(dirtyFlags)) {
					this.cancelScheduledRender();
					this.renderDirtyState(view, dirtyFlags);
					return;
				}
				if (this.shouldRenderLiveStateImmediately()) {
					if (this.tryRenderLiveStateIncrementally(view, dirtyFlags)) {
						this.lastRenderedSignatures = getRenderViewSignatures(view);
						return;
					}
					this.cancelScheduledRender();
					this.renderSubscribedState();
					return;
				}
				this.scheduleRenderFromState();
			}),
		);
	}

	private shouldRenderLiveStateImmediately(): boolean {
		const view = this.deps.getView();
		return view.session?.isRunning === true && view.live?.streamingMessage !== undefined;
	}

	private tryRenderLiveStateIncrementally(
		view = this.deps.getView(),
		dirtyFlags?: RemoteInteractiveViewDirtyFlags,
	): boolean {
		if (
			dirtyFlags &&
			(dirtyFlags.layout || dirtyFlags.chat || dirtyFlags.queue || dirtyFlags.status || dirtyFlags.footer)
		) {
			return false;
		}
		const liveStreamingMessage = view.live?.streamingMessage;
		if (!view.session?.isRunning || !liveStreamingMessage) {
			return false;
		}
		if (liveStreamingMessage.content.some((content) => content.type === "toolCall")) {
			return false;
		}
		const snapshotMatch = findLiveStreamingAssistantSnapshot(view);
		if (snapshotMatch) {
			const componentKey = getSnapshotAssistantComponentKey(snapshotMatch.message, snapshotMatch.index);
			const cached = this.assistantMessageComponents.get(componentKey);
			if (!cached) {
				return false;
			}
			const signature = getAssistantMessageSignature(snapshotMatch.message);
			if (cached.signature !== signature) {
				cached.signature = signature;
				updateAssistantComponentContent(cached.component, snapshotMatch.message);
				this.ui.requestRender();
			}
			return true;
		}
		const componentKey = getLiveAssistantComponentKey(liveStreamingMessage, view.live?.streamingMessageId);
		if (!this.liveAssistantComponent || this.liveAssistantComponent.key !== componentKey) {
			return false;
		}
		this.updateLiveAssistantComponent(componentKey, liveStreamingMessage);
		this.ui.requestRender();
		return true;
	}

	private computeRenderDirtyFlags(
		previousSignatures: RemoteInteractiveViewSignatures | undefined,
		nextView: RemoteInteractiveView,
	): RemoteInteractiveViewDirtyFlags {
		if (!previousSignatures) {
			return {
				layout: true,
				chat: true,
				liveText: true,
				queue: true,
				status: true,
				footer: true,
			};
		}
		const nextSignatures = getRenderViewSignatures(nextView);
		return {
			layout: previousSignatures.layout !== nextSignatures.layout,
			chat: previousSignatures.chat !== nextSignatures.chat,
			liveText: previousSignatures.liveText !== nextSignatures.liveText,
			queue: previousSignatures.queue !== nextSignatures.queue,
			status: previousSignatures.status !== nextSignatures.status,
			footer: previousSignatures.footer !== nextSignatures.footer,
		};
	}

	private canRenderDirtyStateDirectly(dirtyFlags: RemoteInteractiveViewDirtyFlags): boolean {
		if (dirtyFlags.layout || dirtyFlags.chat) {
			return false;
		}
		return dirtyFlags.liveText || dirtyFlags.queue || dirtyFlags.status || dirtyFlags.footer;
	}

	private renderDirtyState(view: RemoteInteractiveView, dirtyFlags: RemoteInteractiveViewDirtyFlags): void {
		const draft = this.deps.getDraft();
		if (!this.activeSelector && this.editor.getText() !== draft) {
			this.editor.setText(draft);
		}
		this.updateActiveSelectorFromView(view);

		if (dirtyFlags.liveText && !this.tryRenderLiveStateIncrementally(view)) {
			this.renderMessages(view);
		}
		if (dirtyFlags.queue) {
			this.renderQueueArea(view);
		}
		if (dirtyFlags.status) {
			this.renderStatusArea(view);
		}
		if (dirtyFlags.footer || dirtyFlags.queue || dirtyFlags.status) {
			this.footer.setView(view);
		}
		this.lastRenderedSignatures = getRenderViewSignatures(view);
		this.ui.requestRender();
	}

	private scheduleRenderFromState(): void {
		if (this.scheduledRender) {
			return;
		}
		this.scheduledRender = setImmediate(() => {
			this.scheduledRender = undefined;
			if (this.isShuttingDown) {
				return;
			}
			this.renderSubscribedState();
		});
		this.scheduledRender.unref?.();
	}

	private renderSubscribedState(): void {
		const draft = this.deps.getDraft();
		if (!this.activeSelector && this.editor.getText() !== draft) {
			this.editor.setText(draft);
		}
		this.renderFromState();
	}

	private cancelScheduledRender(): void {
		if (!this.scheduledRender) {
			return;
		}
		clearImmediate(this.scheduledRender);
		this.scheduledRender = undefined;
	}

	private renderFromState(): void {
		const view = this.deps.getView();
		this.updateActiveSelectorFromView(view);
		this.renderHeader(view);
		this.renderMessages(view);
		this.renderPendingMessages(view);
		this.renderStatusArea(view);
		this.footer.setView(view);
		this.lastRenderedSignatures = getRenderViewSignatures(view);
		this.ui.requestRender();
	}

	private updateActiveSelectorFromView(view: RemoteInteractiveView): void {
		if (this.activeSelectorKind !== "agent-list" || !(this.activeSelector instanceof RemoteAgentSelectorComponent)) {
			return;
		}
		this.activeSelector.updateAgents(view.agents ?? [], view.footer.boundAgentId);
	}

	private renderHeader(view: RemoteInteractiveView): void {
		this.headerContainer.clear();
		const logo = theme.bold(theme.fg("accent", "D-Pi Peer")) + theme.fg("dim", " remote");
		const startupHelp = buildForkedStartupHelp(this.deps.capabilities);
		const headline = view.welcome
			? `${this.deps.peerId} -> ${view.welcome.sessionId.slice(0, 8)}`
			: `${this.deps.peerId} -> connecting`;
		this.headerContainer.addChild(new Text(logo, 1, 0));
		this.headerContainer.addChild(new Text(startupHelp.compact, 1, 0));
		this.headerContainer.addChild(new Text(theme.fg("dim", "Remote InteractiveMode powered by D-Pi hub."), 1, 0));
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(new Text(theme.fg("dim", headline), 1, 0));
		const connectionMessage = this.formatConnectionMessage(view);
		if (connectionMessage) {
			const color =
				view.connection.state === "error" || view.connection.state === "disconnected" ? "warning" : "dim";
			this.headerContainer.addChild(new Text(theme.fg(color, connectionMessage), 1, 0));
		} else if (view.connection.state !== "connected") {
			this.headerContainer.addChild(new Text(theme.fg("warning", `Connection: ${view.connection.state}`), 1, 0));
		}
		if (view.welcome) {
			this.headerContainer.addChild(
				new Text(
					theme.fg(
						"dim",
						`Hub ${view.welcome.hubVersion} • protocol v${view.welcome.protocolVersion} • ${view.peers.length} peers`,
					),
					1,
					0,
				),
			);
		}
		for (const diagnostic of view.status.diagnostics) {
			this.headerContainer.addChild(new Text(theme.fg("warning", diagnostic), 1, 0));
		}
		if (view.status.liveStatusMessage) {
			this.headerContainer.addChild(new Text(theme.fg("dim", view.status.liveStatusMessage), 1, 0));
		}
		if (view.status.lastError) {
			this.headerContainer.addChild(new Text(theme.fg("error", view.status.lastError), 1, 0));
		} else {
			const toolError = getLatestToolErrorText(view.session);
			if (toolError) {
				this.headerContainer.addChild(new Text(theme.fg("error", toolError), 1, 0));
			}
		}
		this.headerContainer.addChild(new Spacer(1));
	}

	private renderMessages(view: RemoteInteractiveView): void {
		this.chatContainer.clear();
		const snapshot = view.session;
		if (!snapshot) {
			this.chatContainer.addChild(new Text(theme.fg("dim", "Connecting to hub..."), 1, 0));
			return;
		}

		const items = snapshot.items ?? [];
		const toolResults = new Map<string, ToolResultPeerMessage>();
		for (const item of items) {
			if (item.type === "message" && item.message.role === "toolResult") {
				toolResults.set(item.message.toolCallId, item.message);
			}
		}
		const pendingToolCallIds = new Set(snapshot.pendingToolCallIds);
		const liveToolExecutions = new Map<string, LiveToolExecution>(
			(view.live?.toolExecutions ?? []).map((execution) => [execution.toolCallId, execution]),
		);
		const renderedToolCallIds = new Set<string>();
		const activeUserComponentKeys = new Set<string>();
		const activeAssistantComponentKeys = new Set<string>();
		const activeToolCallIds = new Set<string>();
		let hasRenderedUserMessage = false;
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			if (item.type === "run_timing") {
				this.renderMetricsLines([formatRunTimingLine(item.timing.durationMs, item.timing.endReason)]);
				continue;
			}
			const message = item.message;
			switch (message.role) {
				case "user": {
					const text = getUserMessageText(message);
					if (!text.trim()) {
						break;
					}
					if (hasRenderedUserMessage) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const componentKey = getSnapshotUserComponentKey(message, i);
					activeUserComponentKeys.add(componentKey);
					this.renderUserMessage(componentKey, text, (message as UserPeerMessage).messageSource);
					hasRenderedUserMessage = true;
					break;
				}
				case "assistant": {
					const componentKey = getSnapshotAssistantComponentKey(message, i);
					activeAssistantComponentKeys.add(componentKey);
					this.renderAssistantMessage(
						message,
						toolResults,
						pendingToolCallIds,
						liveToolExecutions,
						renderedToolCallIds,
						{ snapshotComponentKey: componentKey },
					);
					break;
				}
				case "toolResult":
					break;
				default:
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("dim", JSON.stringify(message)), 1, 0));
			}
		}
		const liveStreamingMessage = view.live?.streamingMessage;
		const shouldRenderLiveStreamingMessage =
			!!liveStreamingMessage &&
			!items.some(
				(item) =>
					item.type === "message" &&
					item.message.role === "assistant" &&
					isSameLiveStreamingAssistantMessage(item.message, liveStreamingMessage, view.live?.streamingMessageId),
			);
		if (shouldRenderLiveStreamingMessage && liveStreamingMessage) {
			this.renderAssistantMessage(
				liveStreamingMessage,
				toolResults,
				pendingToolCallIds,
				liveToolExecutions,
				renderedToolCallIds,
				{ liveComponentKey: getLiveAssistantComponentKey(liveStreamingMessage, view.live?.streamingMessageId) },
			);
			this.renderMetricsLines([formatLiveRunTimingLine(snapshot)]);
		} else {
			this.liveAssistantComponent = undefined;
		}
		for (const toolCallId of renderedToolCallIds) {
			activeToolCallIds.add(toolCallId);
		}
		this.renderLiveToolExecutions(liveToolExecutions, renderedToolCallIds, snapshot.isRunning);
		for (const execution of liveToolExecutions.values()) {
			if (snapshot.isRunning || execution.result === undefined) {
				activeToolCallIds.add(execution.toolCallId);
			}
		}
		if (items.length === 0 && !shouldRenderLiveStreamingMessage) {
			this.chatContainer.addChild(new Text(theme.fg("dim", "Session is ready. Enter a prompt to begin."), 1, 0));
		}
		this.pruneCachedMessageComponents(activeUserComponentKeys, activeAssistantComponentKeys, activeToolCallIds);
	}

	private renderMetricsLines(timingLines: readonly (string | undefined)[]): void {
		const renderableTimingLines = timingLines.filter((line): line is string => Boolean(line));
		if (renderableTimingLines.length === 0) {
			return;
		}
		this.chatContainer.addChild(new Spacer(1));
		for (const line of renderableTimingLines) {
			this.chatContainer.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
	}

	private formatConnectionMessage(view: RemoteInteractiveView): string | undefined {
		const message = view.status.connectionMessage;
		if (!message) {
			return undefined;
		}
		if (view.connection.state === "reconnecting") {
			return `${message} ${keyText("app.connection.retry")} to retry now`;
		}
		return message;
	}

	private renderAssistantMessage(
		message: RenderedAssistantMessage,
		toolResults: Map<string, ToolResultPeerMessage>,
		pendingToolCallIds: Set<string>,
		liveToolExecutions: Map<string, LiveToolExecution>,
		renderedToolCallIds: Set<string>,
		options: AssistantComponentOptions = {},
	): void {
		const component = options.liveComponentKey
			? this.updateLiveAssistantComponent(options.liveComponentKey, message)
			: options.snapshotComponentKey
				? this.updateSnapshotAssistantComponent(options.snapshotComponentKey, message)
				: new AssistantMessageComponent(message, false, this.markdownTheme);
		this.chatContainer.addChild(component);
		for (const content of message.content) {
			if (content.type !== "toolCall") {
				continue;
			}
			renderedToolCallIds.add(content.id);
			const liveExecution = liveToolExecutions.get(content.id);
			const toolResult = toolResults.get(content.id);
			const signature = getSnapshotToolExecutionSignature(
				content,
				liveExecution,
				toolResult,
				pendingToolCallIds.has(content.id),
			);
			const updateComponent = (component: ToolExecutionComponent) => {
				component.updateArgs(content.arguments);
				component.setArgsComplete();
				if (pendingToolCallIds.has(content.id) || toolResult || liveExecution) {
					component.markExecutionStarted();
				}
				if (liveExecution?.partialResult) {
					component.updateResult({ ...liveExecution.partialResult, isError: false }, true);
				}
				if (toolResult) {
					component.updateResult(toolResult, false);
				} else if (liveExecution?.result) {
					component.updateResult({ ...liveExecution.result, isError: liveExecution.isError ?? false }, false);
				}
			};
			const component = this.updateToolExecutionComponent(
				content.id,
				signature,
				() =>
					new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						{},
						undefined,
						this.ui,
						this.deps.cwd,
					),
				updateComponent,
			);
			this.chatContainer.addChild(component);
		}
	}

	private renderUserMessage(
		componentKey: string,
		text: string,
		messageSource: UserPeerMessage["messageSource"],
	): void {
		const messageSourceJson = JSON.stringify(messageSource ?? null);
		let cached = this.userMessageComponents.get(componentKey);
		if (!cached || cached.text !== text || cached.messageSourceJson !== messageSourceJson) {
			cached = {
				text,
				messageSourceJson,
				component: new UserMessageComponent(text, this.markdownTheme, messageSource),
			};
			this.userMessageComponents.set(componentKey, cached);
		}
		this.chatContainer.addChild(cached.component);
	}

	private updateSnapshotAssistantComponent(key: string, message: RenderedAssistantMessage): AssistantMessageComponent {
		const signature = getAssistantMessageSignature(message);
		let cached = this.assistantMessageComponents.get(key);
		if (!cached) {
			const component = new AssistantMessageComponent(undefined, false, this.markdownTheme);
			updateAssistantComponentContent(component, message);
			cached = { signature, component };
			this.assistantMessageComponents.set(key, cached);
			return component;
		}
		if (cached.signature !== signature) {
			cached.signature = signature;
			updateAssistantComponentContent(cached.component, message);
		}
		return cached.component;
	}

	private updateLiveAssistantComponent(key: string, message: RenderedAssistantMessage): AssistantMessageComponent {
		if (!this.liveAssistantComponent || this.liveAssistantComponent.key !== key) {
			this.liveAssistantComponent = {
				key,
				component: new AssistantMessageComponent(undefined, false, this.markdownTheme),
			};
		}
		updateAssistantComponentContent(this.liveAssistantComponent.component, message);
		return this.liveAssistantComponent.component;
	}

	private updateToolExecutionComponent(
		toolCallId: string,
		signature: string,
		createComponent: () => ToolExecutionComponent,
		updateComponent: (component: ToolExecutionComponent) => void,
	): ToolExecutionComponent {
		let cached = this.toolExecutionComponents.get(toolCallId);
		if (!cached) {
			const component = createComponent();
			updateComponent(component);
			cached = { signature, component };
			this.toolExecutionComponents.set(toolCallId, cached);
			return component;
		}
		if (cached.signature !== signature) {
			cached.signature = signature;
			updateComponent(cached.component);
		}
		return cached.component;
	}

	private pruneCachedMessageComponents(
		activeUserKeys: Set<string>,
		activeAssistantKeys: Set<string>,
		activeToolCallIds: Set<string>,
	): void {
		for (const key of this.userMessageComponents.keys()) {
			if (!activeUserKeys.has(key)) {
				this.userMessageComponents.delete(key);
			}
		}
		for (const key of this.assistantMessageComponents.keys()) {
			if (!activeAssistantKeys.has(key)) {
				this.assistantMessageComponents.delete(key);
			}
		}
		for (const key of this.toolExecutionComponents.keys()) {
			if (!activeToolCallIds.has(key)) {
				this.toolExecutionComponents.delete(key);
			}
		}
	}

	private renderLiveToolExecutions(
		liveToolExecutions: Map<string, LiveToolExecution>,
		renderedToolCallIds: Set<string>,
		isRunning: boolean,
	): void {
		for (const execution of liveToolExecutions.values()) {
			if (renderedToolCallIds.has(execution.toolCallId)) {
				continue;
			}
			if (!isRunning && execution.result !== undefined) {
				continue;
			}
			const signature = getLiveToolExecutionSignature(execution);
			const updateComponent = (component: ToolExecutionComponent) => {
				component.updateArgs(execution.args ?? {});
				component.setArgsComplete();
				component.markExecutionStarted();
				if (execution.partialResult) {
					component.updateResult({ ...execution.partialResult, isError: false }, true);
				}
				if (execution.result) {
					component.updateResult({ ...execution.result, isError: execution.isError ?? false }, false);
				}
			};
			const component = this.updateToolExecutionComponent(
				execution.toolCallId,
				signature,
				() =>
					new ToolExecutionComponent(
						execution.toolName,
						execution.toolCallId,
						execution.args ?? {},
						{},
						undefined,
						this.ui,
						this.deps.cwd,
					),
				updateComponent,
			);
			this.chatContainer.addChild(component);
		}
	}

	private async queueInput(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		const parsedCommand = parsePeerCommand(trimmed);
		this.deps.setDraft("");
		this.editor.setText("");
		try {
			if (parsedCommand) {
				await this.handleParsedCommand(parsedCommand);
				return;
			}
			await this.requireQueueWrite()(trimmed);
			this.editor.addToHistory(trimmed);
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
		}
	}

	private requireQueueWrite(): (text: string) => Promise<void> {
		const queueWrite = this.deps.actions.queueWrite ?? this.deps.actions.submitPrompt;
		if (!queueWrite) {
			throw new Error("Queue write action is not available.");
		}
		return queueWrite;
	}

	private requireQueueFlush(): () => Promise<void> {
		const queueFlush = this.deps.actions.queueFlush;
		if (!queueFlush) {
			throw new Error("Queue flush action is not available.");
		}
		return queueFlush;
	}

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) {
			return;
		}
		this.isShuttingDown = true;
		await this.stop();
		this.shutdownResolver?.(0);
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => {
				void this.shutdown();
			};
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private async handleParsedCommand(command: PeerCommandParseResult): Promise<void> {
		switch (command.kind) {
			case "set_model": {
				if (!this.deps.capabilities.supportsModelSelection) {
					this.appendWarningMessage('"/model" is disabled in this remote mode.');
					return;
				}
				const model = this.findModelResource(command.provider, command.modelId);
				if (!model) {
					this.appendWarningMessage(`Unknown model: ${command.provider}/${command.modelId}`);
					return;
				}
				if (!model.resourceId) {
					this.appendWarningMessage(`Model ${command.provider}/${command.modelId} is missing resourceId.`);
					return;
				}
				await this.deps.actions.setModel(model.resourceId);
				this.appendInfoMessage(`Active model changed to ${command.provider}/${command.modelId}.`);
				return;
			}
			case "show_model":
				if (!this.deps.capabilities.supportsModelSelection) {
					this.appendWarningMessage('"/model" is disabled in this remote mode.');
					return;
				}
				this.openModelSelector();
				return;
			case "show_agents":
				if (this.deps.capabilities.supportsAgentSwitching === false) {
					this.appendWarningMessage('"/agents" is disabled in this remote mode.');
					return;
				}
				this.openAgentSelector();
				return;
			case "set_thinking_level":
				if (this.deps.capabilities.supportsSettings === false) {
					this.appendWarningMessage('"/settings" is disabled in this remote mode.');
					return;
				}
				await this.deps.actions.setThinkingLevel(command.level);
				this.appendInfoMessage(`Thinking level changed to ${command.level}.`);
				return;
			case "show_settings":
				if (this.deps.capabilities.supportsSettings === false) {
					this.appendWarningMessage('"/settings" is disabled in this remote mode.');
					return;
				}
				this.openSettingsSelector();
				return;
			case "compact":
				if (!this.deps.capabilities.supportsCompact) {
					this.appendWarningMessage('"/compact" is disabled in this remote mode.');
					return;
				}
				await this.deps.actions.invokeCommand("compact", command.customInstructions);
				this.appendInfoMessage("Requested hub compaction.");
				return;
			case "reload":
				if (!this.deps.capabilities.supportsReload) {
					this.appendWarningMessage('"/reload" is disabled in this remote mode.');
					return;
				}
				await this.deps.actions.invokeCommand("reload");
				this.appendInfoMessage("Requested hub resource reload.");
				return;
			case "show_group":
				if (this.deps.capabilities.supportsGroup === false) {
					this.appendWarningMessage('"/group" is disabled in this remote mode.');
					return;
				}
				this.showGroupSummary();
				return;
			case "show_session":
				if (this.deps.capabilities.supportsSessionDetails === false) {
					this.appendWarningMessage('"/session" is disabled in this remote mode.');
					return;
				}
				this.showSessionSummary();
				return;
			case "show_sources": {
				if (this.deps.capabilities.supportsSources === false) {
					this.appendWarningMessage('"/source" is disabled in this remote mode.');
					return;
				}
				await this.openSourceSelector();
				return;
			}
			case "show_mcp_servers": {
				if (this.deps.capabilities.supportsMcp === false) {
					this.appendWarningMessage('"/mcp" is disabled in this remote mode.');
					return;
				}
				await this.openMcpSelector();
				return;
			}
			case "show_skills": {
				if (this.deps.capabilities.supportsSkills === false) {
					this.appendWarningMessage('"/skills" is disabled in this remote mode.');
					return;
				}
				await this.openSkillSelector();
				return;
			}
			case "disabled":
				this.appendCommandWarning(command.commandName, command.message);
				return;
			case "invalid":
				this.appendCommandWarning(command.commandName, command.message);
				return;
		}
	}

	private showSessionSummary(): void {
		const snapshot = this.deps.getView().session;
		if (!snapshot) {
			this.appendWarningMessage("Session snapshot is not ready yet.");
			return;
		}
		let toolCalls = 0;
		const messages = getSessionMessages(snapshot);
		for (const message of messages) {
			if (message.role === "assistant") {
				toolCalls += message.content.filter((content) => content.type === "toolCall").length;
			}
		}
		const userMessages = messages.filter((message) => message.role === "user").length;
		const assistantMessages = messages.filter((message) => message.role === "assistant").length;
		const toolResults = messages.filter((message) => message.role === "toolResult").length;
		this.appendInfoMessage(
			[
				"Session Info",
				`Session file: ${snapshot.sessionFile}`,
				`Messages: ${messages.length}`,
				`User: ${userMessages}`,
				`Assistant: ${assistantMessages}`,
				`Tool calls: ${toolCalls}`,
				`Tool results: ${toolResults}`,
				`Pending tools: ${snapshot.pendingToolCallIds.length}`,
				`Queued inputs: ${snapshot.queuedMessages?.length ?? 0}`,
			].join("\n"),
		);
	}

	private showGroupSummary(): void {
		const app = this.deps.getView();
		const agents = app.agents ?? [];
		if (agents.length === 0) {
			this.appendWarningMessage("Group snapshot is not ready yet.");
			return;
		}
		const selfId = app.welcome?.agentId ?? "root";
		const agentLines = agents.map((agent) => {
			const suffix = agent.id === selfId ? " (you)" : "";
			const status = agent.isRunning ? "working" : "idle";
			return `- ${agent.id}${suffix}: ${status}, messages=${agent.messageCount}`;
		});
		const peerLines = app.peers.map((peer) => {
			const label = peer.displayName ? `${peer.peerId} (${peer.displayName})` : peer.peerId;
			return `- ${label}: agent=${peer.agentId}, tools=${peer.tools.length}, cwd=${peer.cwd ?? "unknown"}`;
		});
		this.appendInfoMessage(
			[
				"Group Info",
				`Self: ${selfId}`,
				"Agents:",
				...(agentLines.length > 0 ? agentLines : ["- none"]),
				"Executors:",
				'- host: D-Pi hub host workspace, use peer-id "host"',
				...(peerLines.length > 0 ? peerLines : ["- no connected peers"]),
				"Tips:",
				"- Use message_agent for targeted collaboration.",
				"- Use broadcast_message_to_agents for shared updates.",
			].join("\n"),
		);
	}

	private appendInfoMessage(text: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", text), 1, 0));
		this.ui.requestRender();
	}

	private appendWarningMessage(text: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", text), 1, 0));
		this.ui.requestRender();
	}

	private appendCommandWarning(commandName: string, message: string): void {
		this.chatContainer.addChild(new Spacer(1));
		if (commandName.trim().length > 0) {
			this.chatContainer.addChild(new Text(theme.fg("dim", `/${commandName}`), 1, 0));
		}
		this.chatContainer.addChild(new Text(theme.fg("warning", message), 1, 0));
		this.ui.requestRender();
	}

	private renderPendingMessages(view: RemoteInteractiveView): void {
		this.pendingMessagesContainer.clear();
		const queuedMessages = getQueuedMessages(view.session);
		if (queuedMessages.length === 0) {
			this.pendingMessageComponents.clear();
			return;
		}
		this.pendingMessagesContainer.addChild(new Spacer(1));
		const activeQueueKeys = new Set<string>();
		for (const message of queuedMessages) {
			const source = `${message.messageSource.kind}/${message.messageSource.name}`;
			const signature = getQueuedMessageSignature(message);
			activeQueueKeys.add(signature);
			let component = this.pendingMessageComponents.get(signature);
			if (!component) {
				component = new TruncatedText(theme.fg("dim", `Queued [${source}]: ${message.text}`), 1, 0);
				this.pendingMessageComponents.set(signature, component);
			}
			this.pendingMessagesContainer.addChild(component);
		}
		for (const key of this.pendingMessageComponents.keys()) {
			if (!activeQueueKeys.has(key)) {
				this.pendingMessageComponents.delete(key);
			}
		}
		const hintText = theme.fg(
			"dim",
			`↳ ${keyText("app.interrupt")} to flush, ${keyText("app.message.dequeue")} to edit queued messages`,
		);
		this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
	}

	private renderQueueArea(view: RemoteInteractiveView): void {
		this.renderPendingMessages(view);
	}

	private restoreEditor(): void {
		this.activeSelector = undefined;
		this.activeSelectorKind = undefined;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
	}

	private showSelector(kind: SelectorKind, create: SelectorFactory): void {
		const done = () => {
			this.closeSelector();
		};
		const { component, focus } = create(done);
		this.activeSelector = component;
		this.activeSelectorKind = kind;
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private closeSelector(): void {
		this.restoreEditor();
		this.ui.requestRender();
	}

	private openModelSelector(): void {
		const session = this.deps.getView().session;
		if (!session || session.availableModels.length === 0) {
			this.appendWarningMessage("No selectable models were provided by D-Pi hub.");
			return;
		}
		this.showSelector("model", (done) => {
			const selector = new RemoteModelSelectorComponent(
				session.availableModels,
				session.model,
				async (model) => {
					if (!model.resourceId) {
						this.appendWarningMessage(`Model ${model.provider}/${model.modelId} is missing resourceId.`);
						return;
					}
					await this.deps.actions.setModel(model.resourceId);
					done();
				},
				() => done(),
				(error) => {
					this.appendWarningMessage(error instanceof Error ? error.message : String(error));
				},
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private openAgentSelector(): void {
		const view = this.deps.getView();
		const agents = view.agents ?? [];
		if (agents.length === 0) {
			this.appendWarningMessage("No agents are visible to the current token yet.");
			return;
		}
		const currentAgentId = view.footer.boundAgentId;
		this.showSelector("agent-list", (done) => {
			const selector = new RemoteAgentSelectorComponent(
				agents,
				currentAgentId,
				async (agent) => {
					await this.switchAgent(agent);
					done();
				},
				() => done(),
				(error) => {
					this.appendWarningMessage(error instanceof Error ? error.message : String(error));
				},
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private async switchAgent(agent: RemoteInteractiveGroupAgentView): Promise<void> {
		const currentAgentId = this.deps.getView().footer.boundAgentId;
		if (agent.id === currentAgentId) {
			this.appendInfoMessage(`Already connected to agent ${agent.id}.`);
			return;
		}
		if (!this.deps.actions.switchAgent) {
			throw new Error("Agent switching action is not available.");
		}
		await this.deps.actions.switchAgent(agent.id);
		const label = agent.name ? `${agent.id} (${agent.name})` : agent.id;
		this.appendInfoMessage(`Switched to agent ${label}.`);
	}

	private findModelResource(
		provider: string,
		modelId: string,
	): RemoteInteractiveSessionView["availableModels"][number] | undefined {
		return this.deps
			.getView()
			.session?.availableModels.find((model) => model.provider === provider && model.modelId === modelId);
	}

	private openSettingsSelector(): void {
		const session = this.deps.getView().session;
		if (!session || session.availableThinkingLevels.length === 0) {
			this.appendWarningMessage("No selectable settings were provided by D-Pi hub.");
			return;
		}
		this.showSelector("settings", (done) => {
			const selector = new RemoteSettingsSelectorComponent(
				session.thinkingLevel,
				session.availableThinkingLevels,
				async (level) => {
					await this.deps.actions.setThinkingLevel(level as PeerThinkingLevel);
					done();
				},
				() => done(),
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private async openSourceSelector(): Promise<void> {
		try {
			this.currentSourceStatuses = await this.deps.actions.getSessionSources();
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		if (this.currentSourceStatuses.length === 0) {
			this.appendInfoMessage("No sources are configured in .pi/sources.json.");
			return;
		}
		this.openSourceListSelector();
	}

	private openSourceListSelector(): void {
		this.showSelector("source-list", () => {
			const selector = new RemoteSourceListSelectorComponent(
				this.currentSourceStatuses,
				(source) => {
					if (!source.resourceId) {
						this.appendWarningMessage(`Source '${source.name}' is missing resourceId.`);
						return;
					}
					this.openSourceDetailSelector(source.resourceId);
				},
				() => this.closeSelector(),
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private openSourceDetailSelector(resourceId: string): void {
		const source = this.currentSourceStatuses.find((entry) => entry.resourceId === resourceId);
		if (!source) {
			this.openSourceListSelector();
			return;
		}
		this.showSelector("source-detail", () => {
			const sourceResourceId = source.resourceId ?? resourceId;
			const selector = new RemoteSourceDetailSelectorComponent(
				source,
				(action) => {
					void this.handleSourceDetailAction(sourceResourceId, action);
				},
				() => this.openSourceListSelector(),
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private async openMcpSelector(): Promise<void> {
		try {
			const { servers, configError } = await this.deps.actions.getMcpServers();
			this.currentMcpServers = servers;
			this.currentMcpConfigError = configError;
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		this.openMcpListSelector();
	}

	private async openSkillSelector(): Promise<void> {
		if (!this.deps.actions.getSkills) {
			this.appendWarningMessage('"/skills" is not available in this remote mode.');
			return;
		}
		try {
			const { skills, diagnostics } = await this.deps.actions.getSkills();
			this.currentSkills = skills;
			this.currentSkillDiagnostics = diagnostics;
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		this.openSkillListSelector();
	}

	private openSkillListSelector(): void {
		this.showSelector("skill-list", () => {
			const selector = new RemoteSkillListSelectorComponent(
				this.currentSkills,
				this.currentSkillDiagnostics,
				(skill) => this.openSkillDetailSelector(skill),
				() => this.closeSelector(),
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private openSkillDetailSelector(skill: HubSkillInfo): void {
		this.showSelector("skill-detail", () => {
			const selector = new RemoteSkillDetailSelectorComponent(skill, () => this.openSkillListSelector());
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private openMcpListSelector(): void {
		this.showSelector("mcp-list", () => {
			const selector = new RemoteMcpListSelectorComponent(
				this.currentMcpServers,
				this.currentMcpConfigError,
				(server) => {
					if (!server.resourceId) {
						this.appendWarningMessage(`MCP server '${server.name}' is missing resourceId.`);
						return;
					}
					void this.openMcpDetailSelector(server.resourceId);
				},
				() => {
					this.closeSelector();
				},
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private async openMcpDetailSelector(resourceId: string): Promise<void> {
		let status: McpRuntimeStatus | undefined = this.currentMcpServers.find(
			(entry) => entry.resourceId === resourceId,
		);
		if (!status) {
			try {
				const { servers, configError } = await this.deps.actions.getMcpServers();
				this.currentMcpServers = servers;
				this.currentMcpConfigError = configError;
				status = this.currentMcpServers.find((entry) => entry.resourceId === resourceId);
			} catch (error) {
				this.appendWarningMessage(error instanceof Error ? error.message : String(error));
				this.openMcpListSelector();
				return;
			}
		}
		if (!status) {
			this.openMcpListSelector();
			return;
		}
		const server = status;
		this.showSelector("mcp-detail", () => {
			const serverResourceId = server.resourceId ?? resourceId;
			const selector = new RemoteMcpDetailSelectorComponent(
				server,
				(action) => {
					void this.handleMcpDetailAction(serverResourceId, action);
				},
				() => {
					this.openMcpListSelector();
				},
			);
			return { component: selector, focus: selector.getFocusTarget() };
		});
	}

	private async handleMcpDetailAction(resourceId: string, action: McpDetailAction): Promise<void> {
		try {
			switch (action) {
				case "pause":
					await this.deps.actions.pauseMcpServer(resourceId);
					break;
				case "restart":
					await this.deps.actions.restartMcpServer(resourceId);
					break;
				case "remove":
					await this.deps.actions.removeMcpServer(resourceId);
					break;
			}
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		try {
			const { servers, configError } = await this.deps.actions.getMcpServers();
			this.currentMcpServers = servers;
			this.currentMcpConfigError = configError;
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		const stillPresent = this.currentMcpServers.some((entry) => entry.resourceId === resourceId);
		const displayName = serverNameForResourceId(this.currentMcpServers, resourceId) ?? resourceId;
		if (!stillPresent) {
			this.appendInfoMessage(`MCP server '${displayName}' removed.`);
			this.openMcpListSelector();
			return;
		}
		if (action === "remove") {
			this.appendWarningMessage(`MCP server '${displayName}' could not be removed.`);
			this.openMcpListSelector();
			return;
		}
		if (action === "pause") {
			this.appendInfoMessage(`MCP server '${displayName}' paused.`);
		} else {
			this.appendInfoMessage(`MCP server '${displayName}' restarted.`);
		}
		await this.openMcpDetailSelector(resourceId);
	}

	private async handleSourceDetailAction(resourceId: string, action: SourceDetailAction): Promise<void> {
		try {
			switch (action) {
				case "pause":
					this.currentSourceStatuses = await this.deps.actions.pauseSource(resourceId);
					break;
				case "restart":
					this.currentSourceStatuses = await this.deps.actions.restartSource(resourceId);
					break;
				case "remove":
					this.currentSourceStatuses = await this.deps.actions.removeSource(resourceId);
					break;
			}
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		if (this.currentSourceStatuses.length === 0) {
			this.closeSelector();
			this.appendInfoMessage("No sources remain in .pi/sources.json.");
			return;
		}
		this.openSourceListSelector();
	}

	private async handleClearAction(): Promise<void> {
		const now = Date.now();
		if (now - this.lastClearActionTime < 500) {
			await this.shutdown();
			return;
		}
		this.lastClearActionTime = now;
		this.deps.setDraft("");
		this.editor.setText("");
		this.ui.requestRender();
	}

	private async handleDequeue(): Promise<void> {
		const queuedMessages = getQueuedMessages(this.deps.getView().session);
		if (queuedMessages.length === 0) {
			this.appendInfoMessage("No queued messages to restore.");
			return;
		}
		const queuedText = queuedMessages.map((message) => message.text).join("\n\n");
		const currentText = this.editor.getText();
		const combinedText = [queuedText, currentText].filter((text) => text.trim().length > 0).join("\n\n");
		try {
			await this.deps.actions.invokeCommand("dequeue");
			this.deps.setDraft(combinedText);
			this.editor.setText(combinedText);
			this.ui.requestRender();
		} catch (error) {
			this.appendWarningMessage(error instanceof Error ? error.message : String(error));
		}
	}

	private renderStatusArea(view: RemoteInteractiveView): void {
		if (view.session?.isRunning) {
			this.startWorkingStatusTimer(view.session.runStartedAt);
			const statusMessage = this.createWorkingStatusMessage(view);
			if (!this.statusLoader) {
				this.statusContainer.clear();
				this.statusLoaderMessage = statusMessage;
				this.statusLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					statusMessage,
				);
				this.statusContainer.addChild(this.statusLoader);
			} else {
				this.setStatusLoaderMessage(statusMessage);
			}
			return;
		}

		this.stopWorkingStatusTimer();
		this.statusLoader?.stop();
		this.statusLoader = undefined;
		this.statusLoaderMessage = undefined;
		this.statusContainer.clear();
		if (view.status.liveStatusMessage) {
			this.statusContainer.addChild(new Spacer(1));
			this.statusContainer.addChild(new Text(theme.fg("dim", view.status.liveStatusMessage), 1, 0));
			return;
		}
		this.statusContainer.addChild(new Spacer(1));
	}

	private createWorkingStatusMessage(view: RemoteInteractiveView): string {
		const elapsed = getElapsedRunDurationMs(view.session?.runStartedAt);
		const message =
			elapsed === undefined
				? `Working... (${keyText("app.interrupt")} to interrupt)`
				: `Working ${formatPeerRunDuration(elapsed)}... (${keyText("app.interrupt")} to interrupt)`;
		return view.status.crdtResyncMessage ? `${message} · ${view.status.crdtResyncMessage}` : message;
	}

	private startWorkingStatusTimer(runStartedAt: string | undefined): void {
		if (!runStartedAt) {
			this.stopWorkingStatusTimer();
			return;
		}
		if (this.workingStatusTimer && this.workingStatusTimerStartedAt === runStartedAt) {
			return;
		}
		this.stopWorkingStatusTimer();
		this.workingStatusTimerStartedAt = runStartedAt;
		this.workingStatusTimer = setInterval(() => this.updateWorkingStatusMessage(), 1000);
		this.workingStatusTimer.unref?.();
	}

	private updateWorkingStatusMessage(): void {
		if (!this.statusLoader) {
			return;
		}
		const view = this.deps.getView();
		this.setStatusLoaderMessage(this.createWorkingStatusMessage(view));
		if (view.session?.isRunning === true && view.live?.streamingMessage) {
			this.renderMessages(view);
		}
	}

	private setStatusLoaderMessage(message: string): void {
		if (this.statusLoaderMessage === message) {
			return;
		}
		this.statusLoaderMessage = message;
		this.statusLoader?.setMessage(message);
	}

	private stopWorkingStatusTimer(): void {
		if (this.workingStatusTimer) {
			clearInterval(this.workingStatusTimer);
		}
		this.workingStatusTimer = undefined;
		this.workingStatusTimerStartedAt = undefined;
	}

	private createAutocompleteProvider(): CombinedAutocompleteProvider {
		return new CombinedAutocompleteProvider(this.createSlashCommands(), this.deps.cwd, null);
	}

	private createSlashCommands(): SlashCommand[] {
		const commands = this.deps.getView().commands.map<SlashCommand>((command) => ({
			name: command.name,
			description: command.description,
		}));

		for (const command of commands) {
			if (command.name === "model") {
				command.argumentHint = "<provider>/<model-id>";
				command.getArgumentCompletions = async (argumentPrefix: string) => {
					const models = this.deps.getView().session?.availableModels ?? [];
					const normalizedPrefix = argumentPrefix.trim().toLowerCase();
					const items = models
						.map((model) => ({
							value: `${model.provider}/${model.modelId}`,
							label: model.modelId,
							description: model.provider,
						}))
						.filter((item) =>
							normalizedPrefix.length === 0
								? true
								: `${item.value} ${item.label} ${item.description}`.toLowerCase().includes(normalizedPrefix),
						);
					return items.length > 0 ? items : null;
				};
			}
			if (command.name === "settings") {
				command.argumentHint = "thinking <level>";
				command.getArgumentCompletions = async (argumentPrefix: string) => {
					const normalizedPrefix = argumentPrefix.trim().toLowerCase();
					const settingsPrefix = "thinking";
					if (normalizedPrefix.length === 0 || settingsPrefix.startsWith(normalizedPrefix)) {
						return [{ value: "thinking ", label: "thinking", description: "Change thinking level" }];
					}
					if (!normalizedPrefix.startsWith("thinking")) {
						return null;
					}
					const levelPrefix = normalizedPrefix.replace(/^thinking\s*/, "");
					const levels = this.deps.getView().session?.availableThinkingLevels ?? [];
					const items = levels
						.filter((level) => levelPrefix.length === 0 || level.toLowerCase().includes(levelPrefix))
						.map((level) => ({
							value: `thinking ${level}`,
							label: level,
							description: "Thinking level",
						}));
					return items.length > 0 ? items : null;
				};
			}
		}

		return commands;
	}
}

function getUserMessageText(message: Extract<PeerMessage, { role: "user" }>): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n");
	return (message as UserPeerMessage).messageSource ? stripPersistedMessageSourceHeader(text) : text;
}

function stripPersistedMessageSourceHeader(text: string): string {
	const lines = text.split("\n");
	if (!lines[0]?.startsWith("[message source:")) {
		return text;
	}
	let index = 0;
	while (index < lines.length && isPersistedMessageSourceHeaderLine(lines[index]!)) {
		index += 1;
	}
	return lines.slice(index).join("\n");
}

function isPersistedMessageSourceHeaderLine(line: string): boolean {
	return (
		line.startsWith("[message source:") ||
		line.startsWith("[message sent at:") ||
		line.startsWith("[security note:") ||
		line.startsWith("[message source auth token") ||
		line.startsWith("[message source user:") ||
		line.startsWith("[message source purpose:")
	);
}

function getElapsedRunDurationMs(runStartedAt: string | undefined): number | undefined {
	if (!runStartedAt) {
		return undefined;
	}
	const startedAtMs = Date.parse(runStartedAt);
	if (!Number.isFinite(startedAtMs)) {
		return undefined;
	}
	return Math.max(0, Date.now() - startedAtMs);
}

function formatPeerRunDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
}

function formatRunTimingLine(durationMs: number, reason: RemoteInteractiveSessionView["lastRunEndReason"]): string {
	const suffix = reason === "interrupted" ? "（已中断）" : reason === "error" ? "（异常结束）" : "";
	return `本轮用时: ${formatPeerRunDuration(durationMs)}${suffix}`;
}

function formatLiveRunTimingLine(snapshot: RemoteInteractiveSessionView): string | undefined {
	const durationMs = getElapsedRunDurationMs(snapshot.runStartedAt);
	return durationMs === undefined ? undefined : formatRunTimingLine(durationMs, snapshot.lastRunEndReason);
}

function getSessionMessages(snapshot: RemoteInteractiveSessionView): PeerMessage[] {
	return (snapshot.items ?? []).flatMap((item) => (item.type === "message" ? [item.message] : []));
}

function getLatestToolErrorText(snapshot: RemoteInteractiveSessionView | undefined): string | undefined {
	if (!snapshot) {
		return undefined;
	}
	const messages = getSessionMessages(snapshot);
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role !== "toolResult" || !message.isError) {
			continue;
		}
		const text = message.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim();
		if (text.length > 0) {
			return text;
		}
	}
	return undefined;
}

function getAssistantMessageId(message: AssistantPeerMessage): string {
	return `assistant:${message.timestamp}`;
}

function getRenderViewSignatures(view: RemoteInteractiveView): RemoteInteractiveViewSignatures {
	return {
		layout: getLayoutSignature(view),
		chat: getChatSignature(view),
		liveText: getLiveSignature(view),
		queue: getQueueSignature(view),
		status: getStatusSignature(view),
		footer: getFooterSignature(view),
	};
}

function getLayoutSignature(view: RemoteInteractiveView): string {
	return [
		view.welcome?.sessionId,
		view.welcome?.protocolVersion,
		view.welcome?.hubVersion,
		view.welcome?.agentId,
		view.connection.state,
		view.connection.message,
		view.peers.length,
		view.commands.map((command) => `${command.name}:${command.description}`).join("\u0001"),
		view.session?.header?.id,
		view.session?.header?.version,
		view.session?.availableModels
			.map((model) => `${model.resourceId}:${model.provider}/${model.modelId}`)
			.join("\u0001"),
		view.session?.availableThinkingLevels.join("\u0001"),
	].join("\u0002");
}

function getChatSignature(view: RemoteInteractiveView): string {
	const liveMessage = view.live?.streamingMessage;
	const liveMessageId = view.live?.streamingMessageId;
	return (view.session?.items ?? [])
		.map((item, index) => {
			if (item.type === "run_timing") {
				return `run_timing:${index}:${item.timing.durationMs}:${item.timing.endReason}`;
			}
			const message = item.message;
			if (message.role === "user") {
				const messageSource = (message as UserPeerMessage).messageSource;
				const source = messageSource ? `${messageSource.kind}/${messageSource.name}` : "unknown";
				return `user:${index}:${String(message.timestamp)}:${source}:${getTextSignature(getUserMessageText(message))}`;
			}
			if (message.role === "assistant") {
				if (liveMessage && isSameLiveStreamingAssistantMessage(message, liveMessage, liveMessageId)) {
					return `assistant-live:${index}:${String(message.timestamp)}:${liveMessageId ?? ""}`;
				}
				return `assistant:${index}:${String(message.timestamp)}:${getAssistantMessageSignature(message)}`;
			}
			if (message.role === "toolResult") {
				return `toolResult:${index}:${message.toolCallId}:${message.isError === true}:${getToolResultSignature(message)}`;
			}
			return `${index}:${JSON.stringify(message)}`;
		})
		.join("\u0002");
}

function getLiveSignature(view: RemoteInteractiveView): string {
	const live = view.live;
	if (!live) {
		return "";
	}
	const streamingMessageSignature = live.streamingMessage
		? getAssistantMessageSignature(live.streamingMessage)
		: "no-streaming-message";
	const toolSignature = live.toolExecutions.map(getLiveToolExecutionSignature).join("\u0001");
	return [
		live.streamingMessageId,
		live.streamingMessageIndex,
		streamingMessageSignature,
		toolSignature,
		live.statusMessage,
	].join("\u0002");
}

function getQueueSignature(view: RemoteInteractiveView): string {
	return getQueuedMessages(view.session).map(getQueuedMessageSignature).join("\u0002");
}

function getQueuedMessageSignature(
	message: NonNullable<RemoteInteractiveSessionView["queuedMessages"]>[number],
): string {
	return [message.messageSource.kind, message.messageSource.name, message.text.length, message.text].join("\u0001");
}

function getStatusSignature(view: RemoteInteractiveView): string {
	return [
		view.connection.state,
		view.status.connectionMessage,
		view.status.liveStatusMessage,
		view.status.crdtResyncMessage,
		view.status.lastError,
		view.status.diagnostics.join("\u0001"),
		view.session?.isRunning === true,
		view.session?.runStartedAt,
	].join("\u0002");
}

function getFooterSignature(view: RemoteInteractiveView): string {
	const footer = view.footer;
	return [
		footer.cwd,
		footer.modelLabel,
		footer.queueSummary,
		footer.pendingToolCount,
		footer.peerCount,
		footer.isRunning,
		footer.peerId,
		footer.boundAgentId,
		footer.sessionId,
		footer.contextWindow,
		footer.contextUsage?.percent,
	].join("\u0002");
}

function findLiveStreamingAssistantSnapshot(
	view: RemoteInteractiveView,
): { index: number; message: AssistantPeerMessage } | undefined {
	const liveStreamingMessage = view.live?.streamingMessage;
	if (!liveStreamingMessage || !view.session) {
		return undefined;
	}
	const items = view.session.items ?? [];
	const streamingIndex = view.live?.streamingMessageIndex;
	if (streamingIndex !== undefined) {
		const item = items[streamingIndex];
		if (item?.type === "message" && item.message.role === "assistant") {
			return { index: streamingIndex, message: item.message };
		}
	}
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i];
		const message = item?.type === "message" ? item.message : undefined;
		if (
			message?.role === "assistant" &&
			isSameLiveStreamingAssistantMessage(message, liveStreamingMessage, view.live?.streamingMessageId)
		) {
			return { index: i, message };
		}
	}
	return undefined;
}

function getSnapshotUserComponentKey(message: UserPeerMessage, index: number): string {
	return `user:${index}:${String(message.timestamp)}`;
}

function getSnapshotAssistantComponentKey(message: AssistantPeerMessage, index: number): string {
	return `assistant:${index}:${message.timestamp}`;
}

function getLiveAssistantComponentKey(
	message: LiveAssistantPeerMessage,
	liveStreamingMessageId: string | undefined,
): string {
	return liveStreamingMessageId ?? `live-assistant:${message.timestamp}`;
}

function getAssistantMessageSignature(message: RenderedAssistantMessage): string {
	const contentSignature = message.content.map(getAssistantContentSignature).join("\u0001");
	return [contentSignature, message.stopReason, message.errorMessage].join("\u0002");
}

function getAssistantContentSignature(content: RenderedAssistantMessage["content"][number]): string {
	if (content.type === "text") {
		return `text:${getTextSignature(content.text)}`;
	}
	if (content.type === "thinking") {
		return `thinking:${getTextSignature(content.thinking)}`;
	}
	if (content.type === "toolCall") {
		return `toolCall:${content.id}:${content.name}:${getStableValueSignature(content.arguments)}`;
	}
	return getStableValueSignature(content);
}

function getSnapshotToolExecutionSignature(
	content: AssistantToolCallContent,
	liveExecution: LiveToolExecution | undefined,
	toolResult: ToolResultPeerMessage | undefined,
	isPending: boolean,
): string {
	return [
		content.id,
		content.name,
		isPending,
		getStableValueSignature(content.arguments),
		liveExecution ? getLiveToolExecutionSignature(liveExecution) : "",
		toolResult ? getToolResultSignature(toolResult) : "",
	].join("\u0002");
}

function getLiveToolExecutionSignature(execution: LiveToolExecution): string {
	return [
		execution.toolCallId,
		execution.toolName,
		getStableValueSignature(execution.args ?? {}),
		getStableValueSignature(execution.partialResult ?? null),
		getStableValueSignature(execution.result ?? null),
		execution.isError === true,
	].join("\u0002");
}

function getToolResultSignature(message: ToolResultPeerMessage): string {
	return [
		message.toolCallId,
		message.isError === true,
		message.content
			.map((content) =>
				content.type === "text" ? `text:${getTextSignature(content.text)}` : getStableValueSignature(content),
			)
			.join("\u0001"),
	].join("\u0002");
}

function getTextSignature(text: string): string {
	return `${text.length}:${hashString(text)}`;
}

function hashString(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function getStableValueSignature(value: unknown): string {
	return JSON.stringify(value);
}

export function updateAssistantComponentContent(
	component: IncrementalAssistantMessageComponent,
	message: RenderedAssistantMessage,
): void {
	if (component.tryUpdateContentIncrementally?.(message)) {
		return;
	}
	component.updateContent(message);
}

function isSameLiveStreamingAssistantMessage(
	message: AssistantPeerMessage,
	liveStreamingMessage: LiveAssistantPeerMessage,
	liveStreamingMessageId: string | undefined,
): boolean {
	if (liveStreamingMessageId && getAssistantMessageId(message) === liveStreamingMessageId) {
		return true;
	}
	return message.timestamp === liveStreamingMessage.timestamp;
}

function getQueuedMessages(
	snapshot: RemoteInteractiveSessionView | undefined,
): NonNullable<RemoteInteractiveSessionView["queuedMessages"]> {
	return [...(snapshot?.queuedMessages ?? [])];
}
