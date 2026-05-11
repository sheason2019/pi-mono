import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	AuthStorage,
	type CompactionResult,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createEventBus,
	createExtensionRuntime,
	getAgentDir,
	type LoadExtensionsResult,
	type ModelCycleResult,
	ModelRegistry,
	type ResourceLoader,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../../../coding-agent/src/core/extensions/loader.js";
import {
	createAggregatedAgentSessionServices,
	materializeAggregatedModelsConfig,
} from "../config-aggregation/agent-config-services.js";
import {
	appendDPiExtensionFactory,
	createDPiExtensionFactory,
	isDynamicMcpToolName,
} from "../extensions/d-pi-extension.js";
import { materializeMergedModelsConfig } from "../models-config.js";
import { HubResourceLoader } from "../resources/hub-resource-loader.js";
import { DEFAULT_AVAILABLE_THINKING_LEVELS, serializeAvailableModels } from "../session/session-options.js";
import type { LiveRenderEvent } from "../transport/live-events.js";
import type { HubLogDetails, HubLogSink } from "../tui/hub-log.js";
import { HubAgentSessionLogger } from "./hub-agent-session-logger.js";
import {
	type CreateHubAgentAdapterOptions,
	createAgentMessageSource,
	createHostMessageSource,
	createPeerMessageSource,
	createSourceMessageSource,
	type HubAgentAdapterApi,
	type InputQueueFlushResult,
	type MessageSourceMetadata,
	type QueuedInputMessage,
} from "./types.js";

function queuedInputMessageToAgentMessage(message: QueuedInputMessage, timestamp = Date.now()): AgentMessage {
	const sourceAwareMessage: AgentMessage & { messageSource: QueuedInputMessage["messageSource"] } = {
		role: "user",
		content: [{ type: "text", text: message.text }],
		timestamp,
		messageSource: message.messageSource,
	};
	return sourceAwareMessage;
}

async function appendLoadedExtensionToResourceLoader(
	resourceLoader: ResourceLoader,
	factory: ReturnType<typeof createDPiExtensionFactory>,
	cwd: string,
): Promise<ResourceLoader> {
	const extensionPath = "<d-pi-inline>";
	const extension = await loadExtensionFromFactory(
		factory,
		cwd,
		createEventBus(),
		createExtensionRuntime(),
		extensionPath,
	);
	return {
		getExtensions(): LoadExtensionsResult {
			const result = resourceLoader.getExtensions();
			return {
				...result,
				extensions: result.extensions.some((existing) => existing.path === extensionPath)
					? result.extensions
					: [...result.extensions, extension],
			};
		},
		getSkills: () => resourceLoader.getSkills(),
		getPrompts: () => resourceLoader.getPrompts(),
		getThemes: () => resourceLoader.getThemes(),
		getAgentsFiles: () => resourceLoader.getAgentsFiles(),
		getSystemPrompt: () => resourceLoader.getSystemPrompt(),
		getAppendSystemPrompt: () => resourceLoader.getAppendSystemPrompt(),
		extendResources: (paths) => resourceLoader.extendResources(paths),
		reload: () => resourceLoader.reload(),
	};
}

function getAssistantErrorMessage(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") {
		return undefined;
	}
	if (!("errorMessage" in message)) {
		return undefined;
	}
	if ("stopReason" in message && message.stopReason === "aborted") {
		return undefined;
	}
	return typeof message.errorMessage === "string" && message.errorMessage.length > 0
		? message.errorMessage
		: undefined;
}

function getToolExecutionErrorMessage(
	toolName: string,
	result: { content?: Array<{ type: string; text?: string }> },
): string {
	const text = result.content
		?.filter((content): content is { type: "text"; text: string } => content.type === "text" && !!content.text)
		.map((content) => content.text)
		.join("\n")
		.trim();
	return text && text.length > 0 ? text : `Tool "${toolName}" failed.`;
}

function getAssistantMessageId(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") {
		return undefined;
	}
	return `assistant:${message.timestamp}`;
}

function getMessageId(message: AgentMessage): string | undefined {
	if (message.role === "assistant") {
		return getAssistantMessageId(message);
	}
	if (message.role === "toolResult") {
		return `tool:${message.toolCallId}:${message.timestamp}`;
	}
	return `${message.role}:${message.timestamp}`;
}

function getMessageLiveKey(message: AgentMessage): string {
	const source = "messageSource" in message ? message.messageSource : undefined;
	const toolCallId = message.role === "toolResult" ? message.toolCallId : undefined;
	return JSON.stringify({
		role: message.role,
		timestamp: message.timestamp,
		source,
		toolCallId,
		text: getMessageTextForId(message),
	});
}

function getMessageTextForId(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function mapAgentSessionEventToLiveRenderEvent(event: AgentSessionEvent): LiveRenderEvent | undefined {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end": {
			const message = event.message;
			const messageId = getMessageId(message);
			if (!messageId) {
				return undefined;
			}
			if (message.role !== "assistant") {
				return {
					type: event.type,
					messageId,
					message,
				};
			}
			return {
				type:
					event.type === "message_start"
						? "assistant_message_start"
						: event.type === "message_update"
							? "assistant_message_update"
							: "assistant_message_end",
				messageId,
				message,
			};
		}
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args as Record<string, unknown>,
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args as Record<string, unknown>,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		case "compaction_start":
			return {
				type: "status",
				message: "Compacting conversation...",
			};
		case "compaction_end":
			return {
				type: "status",
				message: event.aborted
					? "Compaction aborted."
					: event.errorMessage
						? `Compaction failed: ${event.errorMessage}`
						: "Compaction finished.",
			};
		case "auto_retry_start":
			return {
				type: "status",
				message: `Retrying assistant response (${event.attempt}/${event.maxAttempts})...`,
			};
		case "auto_retry_end":
			return {
				type: "status",
				message: event.success ? "Retry succeeded." : `Retry failed: ${event.finalError ?? "unknown error"}`,
			};
		default:
			return undefined;
	}
}

export function shouldSyncBoundSessionForEvent(event: AgentSessionEvent): boolean {
	return event.type !== "message_update";
}

export class HubAgentAdapter implements HubAgentAdapterApi {
	readonly session;
	readonly services;
	readonly extensionsResult: LoadExtensionsResult;
	readonly resourceLoader: HubResourceLoader;
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	/** Hub tool catalog, including static D-Pi tools and dynamic MCP tools. */
	private readonly tools: ToolDefinition[];
	/** Dynamic MCP tools passed by reference to AgentSession customTools. */
	private readonly dynamicTools: ToolDefinition[];
	private readonly sessionService;
	private readonly refreshModelsConfig?: () => void;
	private readonly refreshSources?: () => Promise<void>;
	private readonly refreshMcp?: () => Promise<void>;
	private readonly beforeInputQueueDrain?: CreateHubAgentAdapterOptions["beforeInputQueueDrain"];
	private readonly agentId: string;
	private readonly logs: CreateHubAgentAdapterOptions["logs"];
	private readonly sessionLogger: HubAgentSessionLogger;
	private readonly unsubscribeSessionEvents: () => void;
	private readonly liveEventListeners = new Set<(event: LiveRenderEvent) => void>();
	private readonly inputQueue: QueuedInputMessage[] = [];
	private inputQueuePumpPromise: Promise<void> | undefined;
	private explicitFlushDepth = 0;
	private readonly queuedInputTimes = new WeakMap<QueuedInputMessage, number>();
	private activeAssistantLiveMessageId: string | undefined;
	private assistantLiveMessageSeq = 0;
	private readonly activeMessageLiveIds = new Map<string, string>();
	private messageLiveSeq = 0;
	private abortPromise: Promise<void> | undefined;

	private constructor(options: {
		sessionService: CreateHubAgentAdapterOptions["sessionService"];
		session: HubAgentAdapterApi["session"];
		services: AgentSessionServices;
		extensionsResult: LoadExtensionsResult;
		resourceLoader: HubResourceLoader;
		diagnostics: readonly AgentSessionRuntimeDiagnostic[];
		refreshModelsConfig?: () => void;
		refreshSources?: () => Promise<void>;
		refreshMcp?: () => Promise<void>;
		beforeInputQueueDrain?: CreateHubAgentAdapterOptions["beforeInputQueueDrain"];
		agentId: string;
		logs?: CreateHubAgentAdapterOptions["logs"];
		tools: ToolDefinition[];
		dynamicTools?: ToolDefinition[];
	}) {
		this.sessionService = options.sessionService;
		this.session = options.session;
		this.inputQueue.push(...options.sessionService.getInputQueue());
		this.services = options.services;
		this.extensionsResult = options.extensionsResult;
		this.resourceLoader = options.resourceLoader;
		this.diagnostics = options.diagnostics;
		this.tools = options.tools;
		this.dynamicTools = options.dynamicTools ?? [];
		this.refreshModelsConfig = options.refreshModelsConfig;
		this.refreshSources = options.refreshSources;
		this.refreshMcp = options.refreshMcp;
		this.beforeInputQueueDrain = options.beforeInputQueueDrain;
		this.agentId = options.agentId;
		this.logs = options.logs;
		this.sessionLogger = new HubAgentSessionLogger({ agentId: options.agentId, logs: options.logs });

		this.sessionService.bindAgentSession(this.session, {
			diagnostics: this.diagnostics.map((diagnostic) => `[${diagnostic.type}] ${diagnostic.message}`),
		});
		this.unsubscribeSessionEvents = this.session.subscribe((event) => {
			this.handleSessionEvent(event);
		});
		this.sessionService.syncBoundAgentSession();
	}

	static async create(options: CreateHubAgentAdapterOptions): Promise<HubAgentAdapter> {
		const cwd = options.cwd ?? process.cwd();
		const agentDir = options.agentDir ?? getAgentDir();
		const canInjectInlineExtension = options.services === undefined;
		const extensionTools = options.tools.filter((tool) => !isDynamicMcpToolName(tool.name));
		const dynamicTools = options.tools.filter((tool) => isDynamicMcpToolName(tool.name));
		const dPiExtensionFactory = createDPiExtensionFactory({ tools: extensionTools });
		const resourceLoaderOptions = canInjectInlineExtension
			? appendDPiExtensionFactory(options.resourceLoaderOptions, dPiExtensionFactory)
			: options.resourceLoaderOptions;
		const getConfigLayers = ():
			| ReturnType<NonNullable<CreateHubAgentAdapterOptions["getConfigLayers"]>>
			| undefined => options.getConfigLayers?.() ?? options.configLayers;
		const initialConfigLayers = getConfigLayers();
		const aggregatedConfig =
			options.services === undefined && initialConfigLayers
				? await createAggregatedAgentSessionServices({
						cwd,
						agentDir,
						layers: initialConfigLayers,
						resourceLoaderOptions,
					})
				: undefined;
		const modelsConfig =
			options.services === undefined && aggregatedConfig === undefined
				? materializeMergedModelsConfig(cwd, agentDir)
				: undefined;
		let services = options.services;
		if (!services && aggregatedConfig) {
			services = aggregatedConfig.services;
		}
		if (!services) {
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				modelRegistry: modelsConfig ? ModelRegistry.create(authStorage, modelsConfig.mergedModelsFile) : undefined,
				resourceLoaderOptions,
			});
		}
		if (!canInjectInlineExtension) {
			services.resourceLoader = await appendLoadedExtensionToResourceLoader(
				services.resourceLoader,
				dPiExtensionFactory,
				cwd,
			);
		}
		const resourceLoader = HubResourceLoader.wrap(services.resourceLoader);
		services.resourceLoader = resourceLoader;
		await options.prepareServices?.(services);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionService.getSessionManager(),
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			scopedModels: options.scopedModels,
			customTools: dynamicTools,
		});
		created.session.setActiveToolsByName(options.tools.map((tool) => tool.name));
		const adapter = new HubAgentAdapter({
			sessionService: options.sessionService,
			session: created.session,
			services,
			extensionsResult: created.extensionsResult,
			resourceLoader,
			diagnostics: services.diagnostics,
			tools: options.tools,
			dynamicTools,
			refreshModelsConfig: modelsConfig
				? () => materializeMergedModelsConfig(cwd, agentDir)
				: aggregatedConfig
					? () =>
							materializeAggregatedModelsConfig({
								cwd,
								layers: getConfigLayers() ?? initialConfigLayers ?? [],
								mergedModelsFile: aggregatedConfig.mergedModelsFile,
							})
					: undefined,
			refreshSources: options.refreshSources,
			refreshMcp: options.refreshMcp,
			beforeInputQueueDrain: options.beforeInputQueueDrain,
			agentId: options.agentId ?? "root",
			logs: options.logs,
		});
		await adapter.refreshSessionOptions();
		return adapter;
	}

	async enqueueFromPeer(peerId: string, text: string, metadata?: MessageSourceMetadata): Promise<void> {
		this.enqueueInput({ text, messageSource: createPeerMessageSource(peerId, metadata) });
		this.scheduleInputQueuePump();
	}

	async enqueueFromHost(hostId: string, text: string, metadata?: MessageSourceMetadata): Promise<void> {
		this.enqueueInput({ text, messageSource: createHostMessageSource(hostId, metadata) });
		this.scheduleInputQueuePump();
	}

	async enqueueFromSource(sourceName: string, text: string): Promise<void> {
		this.enqueueInput({ text, messageSource: createSourceMessageSource(sourceName) });
		this.scheduleInputQueuePump();
	}

	async enqueueFromAgent(agentId: string, text: string): Promise<void> {
		this.enqueueInput({ text, messageSource: createAgentMessageSource(agentId) });
		this.scheduleInputQueuePump();
	}

	continueCurrentTranscript(): void {
		void this.session.agent
			.continue()
			.then(() => this.session.agent.waitForIdle())
			.catch((error) => {
				this.sessionService.recordError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				this.sessionService.syncBoundAgentSession();
			});
	}

	requestInputQueuePump(): void {
		this.scheduleInputQueuePump();
	}

	async flushInputQueue(): Promise<InputQueueFlushResult> {
		const queuedMessageCount = this.getQueuedInputMessageCount();
		if (queuedMessageCount === 0) {
			return { flushed: false, messages: 0 };
		}
		const messages = this.drainInputQueue();
		this.sessionService.setInputQueue(this.inputQueue);
		if (messages.length === 0) {
			return { flushed: false, messages: 0 };
		}
		let promptSucceeded = false;
		this.explicitFlushDepth++;
		try {
			if (this.session.isStreaming) {
				const abortStartedAt = Date.now();
				this.sessionService.setRunState(false, "interrupted");
				await this.session.abort();
				this.sessionService.syncBoundAgentSession();
				const abortDurationMs = Date.now() - abortStartedAt;
				this.logQueueSubmit("flush", messages, { abortDurationMs, restartDelayMs: abortDurationMs });
			} else {
				this.logQueueSubmit("flush", messages);
			}
			await this.promptQueuedInputMessages(messages, "flush");
			promptSucceeded = true;
		} catch (error) {
			this.restoreInputQueue(messages);
			throw error;
		} finally {
			this.explicitFlushDepth--;
			this.sessionService.syncBoundAgentSession();
			if (
				promptSucceeded &&
				this.explicitFlushDepth === 0 &&
				this.getQueuedInputMessageCount() > 0 &&
				!this.session.isStreaming
			) {
				this.scheduleInputQueuePump();
			}
		}
		return { flushed: true, messages: queuedMessageCount };
	}

	async dequeue(): Promise<QueuedInputMessage[]> {
		const cleared = this.drainInputQueue();
		this.sessionService.setInputQueue(this.inputQueue);
		this.sessionService.syncBoundAgentSession();
		return cleared;
	}

	private enqueueInput(message: QueuedInputMessage): void {
		this.queuedInputTimes.set(message, Date.now());
		this.inputQueue.push(message);
		this.sessionService.setInputQueue(this.inputQueue);
		this.scheduleInputQueuePumpAfterSessionSettles();
	}

	private getQueuedInputMessageCount(): number {
		return this.inputQueue.length;
	}

	private drainInputQueue(): QueuedInputMessage[] {
		return this.inputQueue.splice(0);
	}

	private drainNextInputMessage(): QueuedInputMessage[] {
		const next = this.inputQueue.shift();
		return next ? [next] : [];
	}

	private restoreInputQueue(messages: readonly QueuedInputMessage[]): void {
		this.inputQueue.unshift(...messages);
		this.sessionService.setInputQueue(this.inputQueue);
	}

	private scheduleInputQueuePump(): void {
		if (this.explicitFlushDepth > 0) {
			return;
		}
		void this.ensureInputQueuePump().catch((error) => {
			this.sessionService.recordError(error instanceof Error ? error.message : String(error));
			this.sessionService.syncBoundAgentSession();
		});
	}

	private scheduleInputQueuePumpAfterSessionSettles(): void {
		this.scheduleInputQueuePumpWhenIdle(8);
	}

	private scheduleInputQueuePumpWhenIdle(attemptsRemaining: number): void {
		setTimeout(() => {
			if (this.explicitFlushDepth > 0 || this.getQueuedInputMessageCount() === 0) {
				return;
			}
			if (this.session.isStreaming) {
				if (attemptsRemaining > 0) {
					this.scheduleInputQueuePumpWhenIdle(attemptsRemaining - 1);
				}
				return;
			}
			this.scheduleInputQueuePump();
		}, 0);
	}

	private ensureInputQueuePump(): Promise<void> {
		if (this.inputQueuePumpPromise) {
			return this.inputQueuePumpPromise;
		}
		const pump = this.pumpInputQueue();
		this.inputQueuePumpPromise = pump;
		void pump.then(
			() => {
				if (this.inputQueuePumpPromise === pump) {
					this.inputQueuePumpPromise = undefined;
				}
				if (this.explicitFlushDepth === 0 && this.getQueuedInputMessageCount() > 0 && !this.session.isStreaming) {
					this.scheduleInputQueuePump();
				}
			},
			() => {
				if (this.inputQueuePumpPromise === pump) {
					this.inputQueuePumpPromise = undefined;
				}
			},
		);
		return pump;
	}

	private async pumpInputQueue(): Promise<void> {
		while (true) {
			if (this.explicitFlushDepth > 0) {
				return;
			}
			if (this.abortPromise) {
				return;
			}
			if (this.session.isStreaming) {
				return;
			}
			const shouldContinue = await this.beforeInputQueueDrain?.();
			if (shouldContinue === false) {
				return;
			}
			if (this.session.isStreaming) {
				return;
			}
			const messages = this.drainNextInputMessage();
			this.sessionService.setInputQueue(this.inputQueue);
			if (messages.length === 0) {
				return;
			}
			try {
				this.logQueueSubmit("auto", messages);
				await this.promptQueuedInputMessages(messages, "auto");
			} catch (error) {
				this.restoreInputQueue(messages);
				throw error;
			} finally {
				this.sessionService.syncBoundAgentSession();
			}
		}
	}

	private async promptQueuedInputMessages(
		messages: readonly QueuedInputMessage[],
		drainMode: "auto" | "flush",
	): Promise<void> {
		if (messages.length === 0) {
			return;
		}
		const now = Date.now();
		let preflightSucceeded = false;
		this.sessionService.setRunState(true);
		try {
			const agentMessages = messages.map((message, index) => queuedInputMessageToAgentMessage(message, now + index));
			preflightSucceeded = true;
			this.log("info", "prompt preflight timing", {
				agentId: this.agentId,
				phase: "preflight",
				drainMode,
				queuedMessages: messages.length,
				durationMs: Math.max(0, Date.now() - now),
				success: true,
			});
			await this.session.agent.prompt(agentMessages);
		} catch (error) {
			if (!preflightSucceeded) {
				this.sessionService.setRunState(false, "error");
			}
			throw error;
		}
	}

	private logQueueSubmit(
		drainMode: "auto" | "flush",
		messages: readonly QueuedInputMessage[],
		details: Partial<Record<"abortDurationMs" | "restartDelayMs", number>> = {},
	): void {
		this.log("info", drainMode === "flush" ? "queue flush submitted" : "queue drain submitted", {
			agentId: this.agentId,
			phase: "queue",
			drainMode,
			queuedMessages: messages.length,
			queueWaitMs: this.getQueueWaitMs(messages),
			...details,
		});
	}

	private getQueueWaitMs(messages: readonly QueuedInputMessage[]): number {
		const now = Date.now();
		let earliest: number | undefined;
		for (const message of messages) {
			const queuedAt = this.queuedInputTimes.get(message);
			if (queuedAt === undefined) {
				continue;
			}
			earliest = earliest === undefined ? queuedAt : Math.min(earliest, queuedAt);
		}
		return earliest === undefined ? 0 : Math.max(0, now - earliest);
	}

	private log(level: keyof HubLogSink, message: string, details: HubLogDetails): void {
		try {
			this.logs?.[level](message, details);
		} catch {
			// Logging must never affect agent execution.
		}
	}

	async abort(): Promise<void> {
		if (this.abortPromise) {
			return this.abortPromise;
		}
		this.abortPromise = this.abortActiveSession();
		try {
			await this.abortPromise;
		} finally {
			this.abortPromise = undefined;
			this.scheduleInputQueuePumpAfterSessionSettles();
		}
	}

	private async abortActiveSession(): Promise<void> {
		if (this.session.isStreaming) {
			this.sessionService.setRunState(false, "interrupted");
		}
		await this.session.abort();
		this.sessionService.syncBoundAgentSession();
	}

	async setModel(model: Model<Api>): Promise<void> {
		await this.session.setModel(model);
		this.sessionService.syncBoundAgentSession();
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const result = await this.session.cycleModel(direction);
		this.sessionService.syncBoundAgentSession();
		return result;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.session.setThinkingLevel(level);
		this.sessionService.syncBoundAgentSession();
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		const result = this.session.cycleThinkingLevel();
		this.sessionService.syncBoundAgentSession();
		return result;
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		const result = await this.session.compact(customInstructions);
		this.sessionService.syncBoundAgentSession();
		return result;
	}

	async reload(): Promise<void> {
		this.refreshModelsConfig?.();
		await this.refreshSources?.();
		await this.refreshMcp?.();
		this.syncDynamicTools();
		await this.session.reload();
		this.services.modelRegistry.refresh();
		await this.refreshCurrentModelFromRegistry();
		this.session.setActiveToolsByName(this.tools.map((tool) => tool.name));
		await this.refreshSessionOptions();
		this.sessionService.syncBoundAgentSession();
	}

	async getAvailableModels(): Promise<Model<Api>[]> {
		return this.services.modelRegistry.getAvailable();
	}

	private async refreshCurrentModelFromRegistry(): Promise<void> {
		const current = this.session.model;
		if (!current) {
			return;
		}
		const refreshed = this.services.modelRegistry.find(current.provider, current.id);
		if (!refreshed || refreshed === current) {
			return;
		}
		await this.session.setModel(refreshed);
	}

	private syncDynamicTools(): void {
		let writeIndex = 0;
		for (const tool of this.tools) {
			if (isDynamicMcpToolName(tool.name)) {
				this.dynamicTools[writeIndex] = tool;
				writeIndex += 1;
			}
		}
		this.dynamicTools.length = writeIndex;
	}

	subscribeLiveEvents(listener: (event: LiveRenderEvent) => void): () => void {
		this.liveEventListeners.add(listener);
		return () => {
			this.liveEventListeners.delete(listener);
		};
	}

	dispose(): void {
		this.unsubscribeSessionEvents();
		this.sessionService.unbindAgentSession();
		this.session.dispose();
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		this.sessionLogger.handle(event);
		this.emitLiveRenderEventForSessionEvent(event);
		switch (event.type) {
			case "agent_start":
				this.sessionService.clearError();
				this.sessionService.setRunState(true);
				this.sessionService.syncBoundAgentSession();
				return;
			case "agent_end":
				this.sessionService.setRunState(false);
				this.sessionService.syncBoundAgentSession();
				this.scheduleInputQueuePump();
				this.scheduleInputQueuePumpAfterSessionSettles();
				return;
			case "message_end": {
				const errorMessage = getAssistantErrorMessage(event.message);
				if (errorMessage) {
					this.sessionService.recordError(errorMessage);
				} else if (event.message.role === "assistant") {
					this.sessionService.clearError();
				}
				this.sessionService.syncBoundAgentSession();
				this.scheduleInputQueuePumpAfterSessionSettles();
				return;
			}
			case "message_update":
			case "message_start":
			case "tool_execution_start":
			case "tool_execution_update":
			case "turn_start":
			case "turn_end":
			case "compaction_start":
			case "compaction_end":
			case "auto_retry_start":
			case "auto_retry_end":
				if (shouldSyncBoundSessionForEvent(event)) {
					this.sessionService.syncBoundAgentSession();
				}
				return;
			case "tool_execution_end":
				if (event.isError) {
					this.sessionService.recordError(getToolExecutionErrorMessage(event.toolName, event.result), {
						endRun: false,
					});
				}
				this.sessionService.syncBoundAgentSession();
				return;
			default:
				this.sessionService.syncBoundAgentSession();
		}
	}

	private emitLiveRenderEventForSessionEvent(event: AgentSessionEvent): void {
		const liveEvent = this.mapSessionEventToLiveRenderEvent(event);
		if (!liveEvent) {
			return;
		}
		for (const listener of this.liveEventListeners) {
			listener(liveEvent);
		}
	}

	private mapSessionEventToLiveRenderEvent(event: AgentSessionEvent): LiveRenderEvent | undefined {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			if (event.type === "message_start" || !this.activeAssistantLiveMessageId) {
				this.assistantLiveMessageSeq += 1;
				this.activeAssistantLiveMessageId = `${this.agentId}:assistant-live:${event.message.timestamp}:${this.assistantLiveMessageSeq}`;
			}
			const messageId = this.activeAssistantLiveMessageId;
			if (event.type === "message_end") {
				this.activeAssistantLiveMessageId = undefined;
			}
			return {
				type:
					event.type === "message_start"
						? "assistant_message_start"
						: event.type === "message_update"
							? "assistant_message_update"
							: "assistant_message_end",
				messageId,
				message: event.message,
			};
		}
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			const messageId = this.getLiveMessageId(event);
			return {
				type: event.type,
				messageId,
				message: event.message,
			};
		}
		return mapAgentSessionEventToLiveRenderEvent(event);
	}

	private getLiveMessageId(
		event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
	): string {
		const key = getMessageLiveKey(event.message);
		let messageId = this.activeMessageLiveIds.get(key);
		if (event.type === "message_start" || !messageId) {
			this.messageLiveSeq += 1;
			messageId = `${this.agentId}:${event.message.role}:${event.message.timestamp}:${this.messageLiveSeq}`;
			this.activeMessageLiveIds.set(key, messageId);
		}
		if (event.type === "message_end") {
			this.activeMessageLiveIds.delete(key);
		}
		return messageId;
	}

	async refreshSessionOptions(): Promise<void> {
		this.sessionService.updateSessionOptions({
			availableModels: serializeAvailableModels(await this.getAvailableModels()),
			availableThinkingLevels: [...DEFAULT_AVAILABLE_THINKING_LEVELS],
		});
	}
}
