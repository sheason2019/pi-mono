import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type {
	AgentSessionProxy,
	BannerData,
	ContextUsageInfo,
	ModelInfo,
	ModelItemData,
	ServeSlashCommand,
	SessionItemData,
	SessionStateSnapshot,
	TokenUsage,
	TreeNodeData,
	UserMessageItem,
} from "./agent-session-proxy.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";

/**
 * Convert proxy-style image format ({ url, mediaType }) to the ImageContent
 * format expected by AgentSession ({ type, data, mimeType }).
 *
 * Supports:
 * - data URLs:  data:image/png;base64,iVBOR...  ->  { type: "image", data: "iVBOR...", mimeType: "image/png" }
 * - bare base64 with mediaType:  { url: "<base64>", mediaType: "image/png" }
 */
function toImageContent(images: Array<{ url: string; mediaType?: string }>): ImageContent[] {
	return images.map(({ url, mediaType }): ImageContent => {
		// Data URL:  data:<mimeType>;base64,<data>
		const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/s);
		if (dataUrlMatch) {
			return { type: "image", data: dataUrlMatch[2], mimeType: dataUrlMatch[1] };
		}
		// Bare base64 — mediaType is required
		if (mediaType) {
			return { type: "image", data: url, mimeType: mediaType };
		}
		throw new Error(
			`Cannot convert image: URL is not a data URL and no mediaType provided. ` +
				`LocalAgentSessionProxy only supports data-URL images or base64 with explicit mediaType.`,
		);
	});
}

/**
 * Local implementation of AgentSessionProxy that wraps an in-process
 * AgentSession + AgentSessionRuntime.
 *
 * Used by serve mode (and could be used by interactive mode in the future).
 */
export class LocalAgentSessionProxy implements AgentSessionProxy {
	private readonly _runtime: AgentSessionRuntime;
	private _banner: BannerData | undefined;
	/** Listeners registered through this proxy — re-subscribed when the session changes */
	private _proxyListeners: Array<(event: AgentSessionEvent) => void> = [];
	private _sessionUnsubscribe: (() => void) | undefined;

	constructor(runtime: AgentSessionRuntime) {
		this._runtime = runtime;
	}

	/** Re-subscribe all proxy listeners to the current session and emit session_replaced */
	resubscribe(reason: "new" | "resume" | "fork" = "new"): void {
		this._resubscribe(reason);
	}

	/** Called by the host mode to wire up the rebindSession callback */
	installRebindCallback(): void {
		this._runtime.setRebindSession(async (_session, reason) => {
			this._resubscribe(reason);
		});
	}

	/** Re-subscribe all proxy listeners to the current session */
	private _resubscribe(reason: "new" | "resume" | "fork" = "new"): void {
		this._sessionUnsubscribe?.();
		this._sessionUnsubscribe = undefined;
		if (this._proxyListeners.length === 0) return;
		const session = this._runtime.session;
		const combinedListener = (event: AgentSessionEvent) => {
			for (const listener of this._proxyListeners) {
				listener(event);
			}
		};
		this._sessionUnsubscribe = session.subscribe(combinedListener);
		// Notify listeners that the session was replaced so they can reset UI
		for (const listener of this._proxyListeners) {
			listener({ type: "session_replaced", reason });
		}
	}

	/** Set the banner data (called by serve mode after initialization) */
	setBanner(banner: BannerData | undefined): void {
		this._banner = banner;
	}

	private get session(): AgentSession {
		return this._runtime.session;
	}

	// =========================================================================
	// Event subscription
	// =========================================================================

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this._proxyListeners.push(listener);
		// If this is the first listener, subscribe to the session
		if (this._proxyListeners.length === 1) {
			this._resubscribe();
		}
		return () => {
			const index = this._proxyListeners.indexOf(listener);
			if (index !== -1) {
				this._proxyListeners.splice(index, 1);
			}
			// If no more listeners, unsubscribe from session
			if (this._proxyListeners.length === 0) {
				this._sessionUnsubscribe?.();
				this._sessionUnsubscribe = undefined;
			}
		};
	}

	// =========================================================================
	// Commands
	// =========================================================================

	async prompt(text: string, options?: { images?: Array<{ url: string; mediaType?: string }> }): Promise<void> {
		const images = options?.images ? toImageContent(options.images) : undefined;
		await this.session.prompt(text, { images });
	}

	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		const converted = images ? toImageContent(images) : undefined;
		// AgentSession.steer() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.steer(text, converted);
	}

	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		const converted = images ? toImageContent(images) : undefined;
		// AgentSession.followUp() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.followUp(text, converted);
	}

	abort(): void {
		// AgentSession.abort() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.abort();
	}

	abortBash(): void {
		this.session.abortBash();
	}

	// =========================================================================
	// State queries
	// =========================================================================

	get model(): string {
		return this.session.model?.id ?? "";
	}

	get thinkingLevel(): ThinkingLevel {
		return this.session.thinkingLevel;
	}

	get isStreaming(): boolean {
		return this.session.isStreaming;
	}

	get isCompacting(): boolean {
		return this.session.isCompacting;
	}

	get isBashRunning(): boolean {
		return this.session.isBashRunning;
	}

	get steeringMessages(): readonly string[] {
		return this.session.getSteeringMessages();
	}

	get followUpMessages(): readonly string[] {
		return this.session.getFollowUpMessages();
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	get sessionName(): string | undefined {
		return this.session.sessionName;
	}

	get messages(): readonly AgentMessage[] {
		return this.session.messages;
	}

	// =========================================================================
	// Session operations
	// =========================================================================

	async compact(customInstructions?: string): Promise<void> {
		await this.session.compact(customInstructions);
	}

	setModel(modelId: string): void {
		// AgentSession.setModel() takes a Model<any> object, not a string.
		// Look up the model by ID from the model registry.
		const registry = this.session.modelRegistry;
		const available = registry.getAvailable();

		// Try "provider/modelId" format first
		const slashIndex = modelId.indexOf("/");
		let model: ReturnType<typeof available.find> | undefined;
		if (slashIndex !== -1) {
			const provider = modelId.slice(0, slashIndex);
			const id = modelId.slice(slashIndex + 1);
			model = registry.find(provider, id);
		}

		// Fallback: search by model ID alone
		if (!model) {
			model = available.find((m) => m.id === modelId);
		}

		if (!model) {
			throw new Error(`Model not found: ${modelId}`);
		}

		// AgentSession.setModel() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.setModel(model);
	}

	cycleModel(direction: 1 | -1): void {
		const dir = direction === 1 ? "forward" : "backward";
		// AgentSession.cycleModel() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.cycleModel(dir);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.session.setThinkingLevel(level);
	}

	cycleThinkingLevel(direction: 1 | -1): void {
		// AgentSession.cycleThinkingLevel() takes no arguments and cycles forward.
		// Implement directional cycling manually.
		const levels = this.session.getAvailableThinkingLevels();
		if (levels.length === 0) return;

		const currentIndex = levels.indexOf(this.session.thinkingLevel);
		const len = levels.length;
		const nextIndex = direction === 1 ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;

		this.session.setThinkingLevel(levels[nextIndex]);
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.session.setAutoCompactionEnabled(enabled);
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.session.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.session.setFollowUpMode(mode);
	}

	// =========================================================================
	// Runtime operations
	// =========================================================================

	async newSession(): Promise<void> {
		await this._runtime.newSession();
	}

	async switchSession(sessionFile: string): Promise<void> {
		await this._runtime.switchSession(sessionFile);
	}

	async fork(entryId?: string): Promise<void> {
		await this._runtime.fork(entryId ?? "");
	}

	renameSession(name: string): void {
		this.session.sessionManager.appendSessionInfo(name);
	}

	setLabel(entryId: string, label: string | undefined): void {
		this.session.sessionManager.appendLabelChange(entryId, label);
	}

	setScopedModels(enabledIds: string[] | null): void {
		if (enabledIds && enabledIds.length > 0) {
			const allModels = this.session.modelRegistry.getAvailable();
			const enabledSet = new Set(enabledIds);
			const scoped = allModels.filter((m) => enabledSet.has(`${m.provider}/${m.id}`));
			this.session.setScopedModels(scoped.map((m) => ({ model: m })));
		} else {
			this.session.setScopedModels([]);
		}
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.session.settingsManager.setEnabledModels(patterns);
	}

	updateSettings(updates: Record<string, unknown>): void {
		const sm = this.session.settingsManager;
		if ("showImages" in updates && typeof updates.showImages === "boolean") sm.setShowImages(updates.showImages);
		if ("imageWidthCells" in updates && typeof updates.imageWidthCells === "number")
			sm.setImageWidthCells(updates.imageWidthCells);
		if ("autoResizeImages" in updates && typeof updates.autoResizeImages === "boolean")
			sm.setImageAutoResize(updates.autoResizeImages);
		if ("blockImages" in updates && typeof updates.blockImages === "boolean") sm.setBlockImages(updates.blockImages);
		if ("enableSkillCommands" in updates && typeof updates.enableSkillCommands === "boolean")
			sm.setEnableSkillCommands(updates.enableSkillCommands);
		if ("transport" in updates && typeof updates.transport === "string") sm.setTransport(updates.transport as any);
		if ("httpIdleTimeoutMs" in updates && typeof updates.httpIdleTimeoutMs === "number")
			sm.setHttpIdleTimeoutMs(updates.httpIdleTimeoutMs);
		if ("theme" in updates && typeof updates.theme === "string") sm.setTheme(updates.theme);
		if ("hideThinkingBlock" in updates && typeof updates.hideThinkingBlock === "boolean")
			sm.setHideThinkingBlock(updates.hideThinkingBlock);
		if ("collapseChangelog" in updates && typeof updates.collapseChangelog === "boolean")
			sm.setCollapseChangelog(updates.collapseChangelog);
		if ("enableInstallTelemetry" in updates && typeof updates.enableInstallTelemetry === "boolean")
			sm.setEnableInstallTelemetry(updates.enableInstallTelemetry);
		if ("doubleEscapeAction" in updates && typeof updates.doubleEscapeAction === "string")
			sm.setDoubleEscapeAction(updates.doubleEscapeAction as any);
		if ("treeFilterMode" in updates && typeof updates.treeFilterMode === "string")
			sm.setTreeFilterMode(updates.treeFilterMode as any);
		if ("showHardwareCursor" in updates && typeof updates.showHardwareCursor === "boolean")
			sm.setShowHardwareCursor(updates.showHardwareCursor);
		if ("editorPaddingX" in updates && typeof updates.editorPaddingX === "number")
			sm.setEditorPaddingX(updates.editorPaddingX);
		if ("autocompleteMaxVisible" in updates && typeof updates.autocompleteMaxVisible === "number")
			sm.setAutocompleteMaxVisible(updates.autocompleteMaxVisible);
		if ("quietStartup" in updates && typeof updates.quietStartup === "boolean")
			sm.setQuietStartup(updates.quietStartup);
		if ("clearOnShrink" in updates && typeof updates.clearOnShrink === "boolean")
			sm.setClearOnShrink(updates.clearOnShrink);
		if ("showTerminalProgress" in updates && typeof updates.showTerminalProgress === "boolean")
			sm.setShowTerminalProgress(updates.showTerminalProgress);
		if ("warnings" in updates && typeof updates.warnings === "object" && updates.warnings !== null)
			sm.setWarnings(updates.warnings as any);
	}

	async reload(): Promise<void> {
		await this.session.reload();
	}

	getTree(): TreeNodeData[] {
		const tree = this.session.sessionManager.getTree();
		return tree.map((node) => this._convertTreeNode(node));
	}

	private _convertTreeNode(node: {
		entry: { id: string; type: string; parentId: string | null; timestamp: string };
		children: unknown[];
		label?: string;
	}): TreeNodeData {
		let preview: string | undefined;
		const entry = node.entry;
		if (entry.type === "message") {
			const msg = (
				entry as unknown as {
					type: "message";
					message: { role: string; content: string | Array<{ type: string; text?: string }> };
				}
			).message;
			if (msg.role === "user") {
				preview =
					typeof msg.content === "string"
						? msg.content.slice(0, 80)
						: msg.content
								.filter((p): p is { type: "text"; text: string } => p.type === "text")
								.map((p) => p.text)
								.join(" ")
								.slice(0, 80);
			} else if (msg.role === "assistant") {
				preview = "(assistant)";
			}
		} else if (entry.type === "compaction") {
			preview = "(compaction)";
		}
		return {
			id: entry.id,
			type: entry.type,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			label: node.label,
			preview,
			children: (node.children as unknown[]).map((child) =>
				this._convertTreeNode(child as Parameters<typeof this._convertTreeNode>[0]),
			),
		};
	}

	getUserMessagesForForking(): UserMessageItem[] {
		return this.session.getUserMessagesForForking().map((m) => ({ id: m.entryId, text: m.text }));
	}

	async getSessions(): Promise<SessionItemData[]> {
		const { SessionManager } = await import("./session-manager.ts");
		const cwd = this.session.sessionManager.getCwd();
		const sessions = await SessionManager.list(cwd);
		return sessions.map((s) => ({
			path: s.path,
			id: s.id,
			cwd: s.cwd,
			name: s.name,
			parentSessionPath: s.parentSessionPath,
			created: s.created.toISOString(),
			modified: s.modified.toISOString(),
			messageCount: s.messageCount,
			firstMessage: s.firstMessage,
		}));
	}

	async fetchTree(): Promise<TreeNodeData[]> {
		return this.getTree();
	}

	async fetchUserMessages(): Promise<UserMessageItem[]> {
		return this.getUserMessagesForForking();
	}

	async fetchCommands(): Promise<ServeSlashCommand[]> {
		return this.getCommands();
	}

	getCommands(): ServeSlashCommand[] {
		const commands: ServeSlashCommand[] = [];

		// 1. Builtin commands
		for (const cmd of BUILTIN_SLASH_COMMANDS) {
			commands.push({ name: cmd.name, description: cmd.description, source: "builtin" });
		}
		// /model gets an argument hint
		const modelCmd = commands.find((c) => c.name === "model");
		if (modelCmd) modelCmd.argumentHint = "<provider/model-id>";

		// 2. Prompt templates
		for (const tmpl of this.session.promptTemplates) {
			commands.push({
				name: tmpl.name,
				description: tmpl.description,
				source: "prompt",
				sourceInfo: tmpl.sourceInfo,
			});
		}

		// 3. Extension commands (exclude names that clash with builtins)
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
		for (const cmd of this.session.extensionRunner.getRegisteredCommands()) {
			if (!builtinNames.has(cmd.name)) {
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
					sourceInfo: cmd.sourceInfo,
				});
			}
		}

		// 4. Skill commands (gated by enableSkillCommands)
		if (this.session.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}
		}

		return commands;
	}

	getModels(): ModelItemData[] {
		return this.session.modelRegistry.getAvailable().map((m) => ({
			id: m.id,
			name: m.name,
			provider: m.provider,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			input: m.input,
		}));
	}

	async fetchModels(): Promise<ModelItemData[]> {
		return this.getModels();
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	dispose(): void {
		// Don't dispose runtime here — the mode that created it handles that
	}

	// =========================================================================
	// Extras (not in interface)
	// =========================================================================

	/** Expose runtime for modes that need direct access (e.g., rebindSession callbacks) */
	get runtime(): AgentSessionRuntime {
		return this._runtime;
	}

	/** Snapshot for serve mode */
	getSnapshot(): SessionStateSnapshot {
		const session = this.session;
		const model = session.model;

		// Compute cumulative token usage from all entries
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}
		const usingSubscription = model ? session.modelRegistry.isUsingOAuth(model) : false;
		const tokenUsage: TokenUsage = {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			cost: totalCost,
			usingSubscription,
		};

		// Compute context usage
		const rawContextUsage = session.getContextUsage();
		const contextUsage: ContextUsageInfo = rawContextUsage
			? {
					tokens: rawContextUsage.tokens,
					contextWindow: rawContextUsage.contextWindow,
					percent: rawContextUsage.percent,
				}
			: { tokens: null, contextWindow: model?.contextWindow ?? 0, percent: null };

		// Extract model info
		const modelInfo: ModelInfo = model
			? { id: model.id, provider: model.provider, reasoning: model.reasoning, contextWindow: model.contextWindow }
			: { id: "", provider: "", reasoning: false, contextWindow: 0 };

		return {
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			isStreaming: this.isStreaming,
			isCompacting: this.isCompacting,
			isBashRunning: this.isBashRunning,
			steeringMessages: this.steeringMessages,
			followUpMessages: this.followUpMessages,
			sessionFile: this.sessionFile,
			sessionName: this.sessionName,
			messages: this.messages,
			banner: this._banner,
			tokenUsage,
			contextUsage,
			modelInfo,
			autoCompactEnabled: session.autoCompactionEnabled,
			cwd: session.sessionManager.getCwd(),
			availableProviderCount: session.modelRegistry.getAvailable().length,
			remoteSettings: {
				autoCompact: session.autoCompactionEnabled,
				thinkingLevel: session.thinkingLevel,
				availableThinkingLevels: session.getAvailableThinkingLevels(),
				steeringMode: session.steeringMode,
				followUpMode: session.followUpMode,
				enableSkillCommands: session.settingsManager.getEnableSkillCommands(),
				doubleEscapeAction: session.settingsManager.getDoubleEscapeAction(),
				showImages: session.settingsManager.getShowImages(),
				imageWidthCells: session.settingsManager.getImageWidthCells(),
				autoResizeImages: session.settingsManager.getImageAutoResize(),
				blockImages: session.settingsManager.getBlockImages(),
				transport: session.settingsManager.getTransport(),
				httpIdleTimeoutMs: session.settingsManager.getHttpIdleTimeoutMs(),
				currentTheme: session.settingsManager.getTheme() ?? "",
				availableThemes: session.resourceLoader.getThemes().themes.map((t) => t.name) as string[],
				hideThinkingBlock: session.settingsManager.getHideThinkingBlock(),
				collapseChangelog: session.settingsManager.getCollapseChangelog(),
				enableInstallTelemetry: session.settingsManager.getEnableInstallTelemetry(),
				treeFilterMode: session.settingsManager.getTreeFilterMode(),
				showHardwareCursor: session.settingsManager.getShowHardwareCursor(),
				editorPaddingX: session.settingsManager.getEditorPaddingX(),
				autocompleteMaxVisible: session.settingsManager.getAutocompleteMaxVisible(),
				quietStartup: session.settingsManager.getQuietStartup(),
				clearOnShrink: session.settingsManager.getClearOnShrink(),
				showTerminalProgress: session.settingsManager.getShowTerminalProgress(),
				warnings: session.settingsManager.getWarnings() as unknown as Record<string, unknown>,
			},
			scopedModelIds:
				session.scopedModels.length > 0
					? session.scopedModels.map((sm) => `${sm.model.provider}/${sm.model.id}`)
					: null,
			enabledModelPatterns: session.settingsManager.getEnabledModels(),
			extensionPaths: session.extensionRunner.getExtensionPaths(),
		};
	}
}
