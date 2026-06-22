import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentLocalModelDefinition, AgentModelDefinition, AgentProviderDefinition } from "../agent-definition.ts";
import type { LoadedAgentDefinition } from "../agent-loader.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionMessage,
	InputEvent,
	InputEventResult,
	MessageRenderer,
	ModelRegistry,
	ResourceLoader,
	ToolDefinition,
} from "../extension/contracts.ts";
import { extractDPiMeta } from "../message-meta.ts";
import type { DPiRuntimeEvent } from "../runtime/events.ts";
import {
	appendSteeringMessage,
	clearSteeringMessagesSync,
	readSteeringMessagesSync,
} from "../runtime/steering-jsonl-queue.ts";
import type { DPiTranscriptItem } from "../runtime/transcript/projector.ts";
import type { DPiAgentMessage } from "../runtime/types.ts";
import type {
	DPiInteractiveBannerData,
	DPiInteractiveClientExtensionData,
	DPiInteractiveModelItemData,
	DPiInteractiveRemoteSettings,
	DPiInteractiveSessionItemData,
	DPiInteractiveSlashCommand,
	DPiInteractiveTreeNodeData,
	DPiInteractiveUserMessageItem,
} from "../tui/interactive/agent-session-proxy.ts";
import { DPI_NATIVE_CONNECT_BUILTIN_COMMANDS } from "../tui/interactive/native-parity-manifest.ts";
import type {
	DPiInteractiveRealtimeEvent,
	DPiInteractiveRealtimePage,
	DPiInteractiveRealtimePageReason,
	DPiInteractiveRealtimeState,
	DPiInteractiveStatusState,
} from "../tui/interactive/view-model.ts";
import { createDPiInteractiveRealtimePage } from "../tui/interactive/view-model.ts";

export interface DPiWorkerAuthStorage {
	readonly kind: "d-pi-auth-storage";
}

export interface DPiWorkerSettingsManager {
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
}

export interface DPiRequestAuth {
	apiKey: string;
	headers?: Record<string, string>;
}

export interface DPiWorkerModelRegistry extends ModelRegistry {
	getApiKeyAndHeaders?(model: Model<Api>): Promise<DPiRequestAuth | undefined> | DPiRequestAuth | undefined;
}

export interface DPiWorkerSessionManager {
	readonly cwd: string;
	readonly sessionDir?: string;
}

export interface DPiWorkerInfrastructure {
	agentDir: string;
	authStorage: DPiWorkerAuthStorage;
	settingsManager: DPiWorkerSettingsManager;
	modelRegistry: DPiWorkerModelRegistry;
}

export interface DPiWorkerInfrastructureOptions {
	agentDefinition?: LoadedAgentDefinition;
}

export interface DPiWorkerSession {
	agent: {
		waitForIdle(): Promise<void>;
	};
	resourceLoader: ResourceLoader;
	modelRegistry: DPiWorkerModelRegistry;
	getToolDefinitions(): ToolDefinition[];
	reload(): Promise<void>;
	bindExtensions(options: DPiBindExtensionsOptions): Promise<void>;
	navigateTree(targetId: string, options?: unknown): Promise<{ cancelled: boolean }>;
}

export interface DPiBindExtensionsOptions {
	commandContextActions: {
		waitForIdle(): Promise<void>;
		newSession(options?: unknown): Promise<unknown>;
		fork(entryId: string, options?: unknown): Promise<{ cancelled: boolean }>;
		navigateTree(targetId: string, options?: unknown): Promise<{ cancelled: boolean }>;
		switchSession(sessionPath: string, options?: unknown): Promise<unknown>;
		reload(): Promise<void>;
	};
	abortHandler(): void;
	onError(error: { extensionPath: string; error: unknown }): void;
}

export interface DPiAgentSessionServices {
	diagnostics: unknown[];
	cwd?: string;
	settingsManager?: DPiWorkerSettingsManager;
	modelRegistry?: DPiWorkerModelRegistry;
	resourceLoaderOptions?: {
		extensionFactories?: Array<{ factory: ExtensionFactory; name: string }>;
		appendSystemPromptOverride?: (base: string[]) => string[];
		agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
			agentsFiles: Array<{ path: string; content: string }>;
		};
		additionalSkillPaths?: string[];
		additionalExtensionPaths?: string[];
	};
}

export interface DPiCreateSessionServicesOptions {
	cwd: string;
	agentDir: string;
	authStorage: DPiWorkerAuthStorage;
	settingsManager: DPiWorkerSettingsManager;
	modelRegistry: DPiWorkerModelRegistry;
	resourceLoaderOptions?: DPiAgentSessionServices["resourceLoaderOptions"];
}

export interface DPiCreateSessionFromServicesOptions {
	services: DPiAgentSessionServices;
	sessionManager: DPiWorkerSessionManager;
	model?: Model<Api>;
	tools?: string[];
	excludeTools?: string[];
}

export interface DPiCreateSessionResult {
	session: DPiWorkerSession;
	diagnostics: unknown[];
}

export interface DPiAgentSessionRuntime {
	session: DPiWorkerSession;
	newSession(options?: unknown): Promise<unknown>;
	fork(entryId: string, options?: unknown): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string, options?: unknown): Promise<unknown>;
	setBeforeSessionInvalidate(handler: () => void): void;
	setRebindSession(handler: (session: DPiWorkerSession, reason: "new" | "resume" | "fork") => Promise<void>): void;
}

export type DPiCreateSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: DPiWorkerSessionManager;
}) => Promise<DPiCreateSessionResult & { services: DPiAgentSessionServices }>;

export function createDPiWorkerInfrastructure(
	cwd: string,
	options: DPiWorkerInfrastructureOptions = {},
): DPiWorkerInfrastructure {
	const settingsManager = createSettingsManager(cwd);
	const modelRegistry = createBuiltInModelRegistry(options.agentDefinition);
	return {
		agentDir: cwd,
		authStorage: { kind: "d-pi-auth-storage" },
		settingsManager,
		modelRegistry,
	};
}

export function createDPiSessionManager(cwd: string, sessionDir?: string): DPiWorkerSessionManager {
	return { cwd, ...(sessionDir ? { sessionDir } : {}) };
}

export async function resolveDPiInitialModel(options: {
	modelRegistry: DPiWorkerModelRegistry;
	agentDefinition?: LoadedAgentDefinition;
}): Promise<Model<Api> | undefined> {
	const { agentDefinition, modelRegistry } = options;
	let resolvedModel: Model<Api> | undefined;

	if (agentDefinition?.model) {
		resolvedModel = resolveAgentDefinitionModel(modelRegistry, agentDefinition.model);
	}

	if (resolvedModel) {
		return resolvedModel;
	}

	return undefined;
}

function resolveAgentDefinitionModel(
	modelRegistry: DPiWorkerModelRegistry,
	modelDefinition: AgentModelDefinition,
): Model<Api> | undefined {
	if ("id" in modelDefinition) {
		const provider = resolveAgentModelProvider(modelDefinition.provider);
		return provider ? modelRegistry.find(provider.provider, modelDefinition.id) : undefined;
	}
	return modelRegistry.find(modelDefinition.provider, modelDefinition.name);
}

export function runtimeModelSpecFromResolvedModel(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export async function createDPiAgentSessionServices(
	options: DPiCreateSessionServicesOptions,
): Promise<DPiAgentSessionServices> {
	return {
		diagnostics: [],
		cwd: options.cwd,
		settingsManager: options.settingsManager,
		modelRegistry: options.modelRegistry,
		resourceLoaderOptions: options.resourceLoaderOptions,
	};
}

export async function createDPiAgentSessionFromServices(
	options: DPiCreateSessionFromServicesOptions,
): Promise<DPiCreateSessionResult> {
	return {
		session: createPlaceholderSession(options.services, options.sessionManager, options.model),
		diagnostics: options.services.diagnostics,
	};
}

export async function createDPiAgentSessionRuntime(
	factory: DPiCreateSessionRuntimeFactory,
	options: { cwd: string; agentDir: string; sessionManager: DPiWorkerSessionManager },
): Promise<DPiAgentSessionRuntime> {
	let current = await factory(options);
	let beforeInvalidate: (() => void) | undefined;
	let rebind: ((session: DPiWorkerSession, reason: "new" | "resume" | "fork") => Promise<void>) | undefined;
	let localSessionSequence = 0;

	const recreateSession = async (
		reason: "new" | "resume" | "fork",
		sessionDir: string,
	): Promise<DPiCreateSessionResult & { services: DPiAgentSessionServices }> => {
		beforeInvalidate?.();
		const next = await factory({
			...options,
			sessionManager: createDPiSessionManager(options.cwd, sessionDir),
		});
		current = next;
		await rebind?.(current.session, reason);
		return next;
	};

	const nextSessionPath = (kind: "fork" | "new", detail?: string): string => {
		localSessionSequence += 1;
		const base = options.sessionManager.sessionDir ?? join(options.cwd, ".d-pi-sessions");
		const suffix = detail ? `-${sanitizeSessionPathPart(detail)}` : "";
		return join(base, `${kind}-${localSessionSequence}${suffix}`);
	};

	return {
		get session(): DPiWorkerSession {
			return current.session;
		},
		async newSession(newSessionOptions?: unknown): Promise<unknown> {
			const sessionPath = nextSessionPath("new");
			await recreateSession("new", sessionPath);
			return { sessionPath, options: newSessionOptions };
		},
		async fork(entryId: string, forkOptions?: unknown): Promise<{ cancelled: boolean }> {
			await recreateSession("fork", nextSessionPath("fork", entryId));
			void forkOptions;
			return { cancelled: false };
		},
		async switchSession(sessionPath: string, switchOptions?: unknown): Promise<unknown> {
			await recreateSession("resume", sessionPath);
			return { sessionPath, options: switchOptions };
		},
		setBeforeSessionInvalidate(handler: () => void): void {
			beforeInvalidate = handler;
		},
		setRebindSession(handler: (session: DPiWorkerSession, reason: "new" | "resume" | "fork") => Promise<void>): void {
			rebind = handler;
		},
	};
}

export function generateDPiBanner(session: DPiWorkerSession): DPiInteractiveBannerData {
	const resourceLoader = session.resourceLoader;
	const contextFiles = resourceLoader.getAgentsFiles().agentsFiles;
	const skillsResult = resourceLoader.getSkills();
	const promptsResult = resourceLoader.getPrompts();
	const extensionsResult = resourceLoader.getExtensions();
	const themesResult = resourceLoader.getThemes();
	const loadedResources = [
		...(contextFiles.length > 0
			? [
					{
						name: "Context",
						compactList: contextFiles.map((file) => file.path).join(", "),
						expandedList: contextFiles.map((file) => file.path).join("\n"),
					},
				]
			: []),
		...(skillsResult.skills.length > 0
			? [
					{
						name: "Skills",
						compactList: skillsResult.skills
							.map((skill) => skill.name)
							.sort()
							.join(", "),
						expandedList: skillsResult.skills.map((skill) => skill.filePath ?? skill.name).join("\n"),
					},
				]
			: []),
		...loadedPromptResources(promptsResult.prompts),
		...loadedExtensionResources(extensionsResult.extensions),
		...loadedThemeResources(themesResult.themes),
	];
	const diagnostics = [
		...(skillsResult.diagnostics.length > 0
			? [
					{
						label: "Skill conflicts",
						entries: skillsResult.diagnostics as DPiInteractiveBannerData["diagnostics"][number]["entries"],
					},
				]
			: []),
		...(promptsResult.diagnostics.length > 0
			? [
					{
						label: "Prompt conflicts",
						entries: promptsResult.diagnostics as DPiInteractiveBannerData["diagnostics"][number]["entries"],
					},
				]
			: []),
		...(extensionsResult.errors.length > 0
			? [
					{
						label: "Extension issues",
						entries: extensionsResult.errors.map((error) => ({
							type: "error" as const,
							message: extensionErrorMessage(error),
							...(extensionErrorPath(error) ? { path: extensionErrorPath(error) } : {}),
						})),
					},
				]
			: []),
		...(themesResult.diagnostics.length > 0
			? [
					{
						label: "Theme conflicts",
						entries: themesResult.diagnostics as DPiInteractiveBannerData["diagnostics"][number]["entries"],
					},
				]
			: []),
	];
	return {
		appName: "pi",
		version: nativePiCompatibleVersion(),
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
		loadedResources,
		diagnostics,
		changelogMarkdown: undefined,
	};
}

function nativePiCompatibleVersion(): string {
	return process.env.DPI_NATIVE_PI_VERSION ?? "0.79.6";
}

function loadedPromptResources(prompts: unknown[]): DPiInteractiveBannerData["loadedResources"] {
	const entries = prompts.map((prompt) => ({
		name: promptRecordString(prompt, "name"),
		filePath: promptRecordString(prompt, "filePath"),
	}));
	const named = entries.filter(
		(entry): entry is { name: string; filePath: string | undefined } => entry.name !== undefined,
	);
	return named.length === 0
		? []
		: [
				{
					name: "Prompts",
					compactList: named
						.map((prompt) => `/${prompt.name}`)
						.sort()
						.join(", "),
					expandedList: named.map((prompt) => prompt.filePath ?? `/${prompt.name}`).join("\n"),
				},
			];
}

function loadedExtensionResources(extensions: unknown[]): DPiInteractiveBannerData["loadedResources"] {
	const paths = extensions
		.map((extension) => promptRecordString(extension, "path"))
		.filter((path): path is string => path !== undefined);
	return paths.length === 0
		? []
		: [
				{
					name: "Extensions",
					compactList: paths.map((path) => path.split("/").at(-1) ?? path).join(", "),
					expandedList: paths.join("\n"),
				},
			];
}

function loadedThemeResources(themes: unknown[]): DPiInteractiveBannerData["loadedResources"] {
	const entries = themes
		.map((theme) => ({
			name: promptRecordString(theme, "name"),
			sourcePath: promptRecordString(theme, "sourcePath"),
		}))
		.filter((theme): theme is { name: string; sourcePath: string } => Boolean(theme.name && theme.sourcePath));
	return entries.length === 0
		? []
		: [
				{
					name: "Themes",
					compactList: entries
						.map((theme) => theme.name)
						.sort()
						.join(", "),
					expandedList: entries.map((theme) => theme.sourcePath).join("\n"),
				},
			];
}

function promptRecordString(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function extensionErrorMessage(error: unknown): string {
	return promptRecordString(error, "error") ?? String(error);
}

function extensionErrorPath(error: unknown): string | undefined {
	return promptRecordString(error, "path");
}

function toolResultContent(result: unknown, fallbackText: string): unknown[] {
	if (typeof result === "object" && result !== null && "content" in result) {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			return content;
		}
	}
	if (typeof result === "string") {
		return [{ type: "text", text: result }];
	}
	return [{ type: "text", text: fallbackText }];
}

function toolResultDetails(result: unknown): unknown {
	if (typeof result === "object" && result !== null && "details" in result) {
		return (result as { details?: unknown }).details;
	}
	return undefined;
}

export interface DPiIpcTransport {
	postMessage(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
}

export interface DPiIpcMessageHandlers {
	onHttpResponse(requestId: string, status: number, body: unknown): void;
	onSseEvent(subscriberId: string, event: string, data: unknown): void;
}

export interface DPiLocalAgentMessage {
	id: string;
	role: "assistant" | "custom" | "toolResult" | "user";
	content: unknown;
	customType?: string;
	display?: boolean;
	details?: ExtensionMessage["details"];
	images?: Array<{ url: string; mediaType?: string }>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp: number;
}

export interface DPiLocalQueueItem {
	id: string;
	kind: "follow-up" | "prompt" | "steer";
	text: string;
	images?: Array<{ url: string; mediaType?: string }>;
	timestamp: number;
}

export interface DPiLocalAgentState {
	model: string;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning: boolean;
	steeringMessages: readonly string[];
	followUpMessages: readonly string[];
	sessionFile: string | undefined;
	sessionName: string | undefined;
	tokenUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		usingSubscription: boolean;
		latestCacheHitRate?: number;
	};
	contextUsage: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	modelInfo: {
		id: string;
		provider: string;
		reasoning: boolean;
		contextWindow: number;
	};
	autoCompactEnabled: boolean;
	cwd: string;
	availableProviderCount: number;
	remoteSettings: DPiInteractiveRemoteSettings;
	scopedModelIds: string[] | null;
	enabledModelPatterns: string[] | undefined;
	extensionPaths: string[];
	agent: {
		sessionId: string;
		status: "busy" | "ready";
	};
	session: {
		id: string;
		path?: string;
	};
	banner: DPiInteractiveBannerData | undefined;
	messages: DPiLocalAgentMessage[];
	transcriptItems?: DPiTranscriptItem[];
	streaming: boolean;
	queued: DPiLocalQueueItem[];
	thinking?: ThinkingLevel;
	extensions: DPiSessionExtensionSnapshot;
}

export interface DPiLocalAgentSessionProxyOptions {
	steeringQueuePath?: string;
}

export type DPiLocalAgentEvent =
	| { type: "message"; data: DPiLocalAgentMessage }
	| { type: "queue"; data: { queued: DPiLocalQueueItem[] } }
	| { type: "status"; data: DPiInteractiveStatusState }
	| { type: "realtime"; data: DPiInteractiveRealtimeEvent }
	| { type: "state"; data: DPiLocalAgentState }
	| { type: "new" | "resume" | "fork"; data: DPiLocalAgentState }
	| { type: "turn_stats"; data: Extract<DPiRuntimeEvent, { type: "turn_stats" }> }
	| { type: "agent_start" | "agent_end"; data: { type: "agent_start" } | { type: "agent_end" } }
	| {
			type: "tool_execution_start";
			data: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown };
	  }
	| {
			type: "tool_execution_update";
			data: { type: "tool_execution_update"; toolCallId: string; partialResult: unknown };
	  }
	| {
			type: "tool_execution_end";
			data: { type: "tool_execution_end"; toolCallId: string; result: unknown; isError: boolean };
	  }
	| { type: "compaction_end" | "compaction_start" | "turn_end" | "turn_start"; data?: unknown };

export interface DPiRegisteredTool {
	name: string;
	label: string;
	description: string;
}

export interface DPiRegisteredCommand {
	name: string;
	description: string;
}

export interface DPiSessionExtensionSnapshot {
	tools: DPiRegisteredTool[];
	commands: DPiRegisteredCommand[];
	renderers: string[];
	inputHandlers: number;
	eventHandlers: string[];
}

interface DPiSessionExtensionState extends DPiSessionExtensionSnapshot {
	toolDefinitions: ToolDefinition[];
	commandDefinitions: Array<{
		name: string;
		description: string;
		handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
	}>;
	messageRenderers: Array<{ customType: string; renderer: MessageRenderer<unknown> }>;
	inputHandlerDefinitions: Array<ExtensionHandler<InputEvent, InputEventResult>>;
	eventHandlerDefinitions: Array<{ event: string; handler: ExtensionHandler }>;
	currentModel?: Model<Api>;
	thinking?: ThinkingLevel;
}

interface DPiSessionMetadata {
	id: string;
	path?: string;
	cwd?: string;
	model?: Model<Api>;
}

interface DPiSessionMessageState {
	messages: DPiLocalAgentMessage[];
	listeners: Set<(message: DPiLocalAgentMessage) => void>;
}

const sessionExtensionStates = new WeakMap<DPiWorkerSession, DPiSessionExtensionState>();
const sessionMetadata = new WeakMap<DPiWorkerSession, DPiSessionMetadata>();
const sessionMessageStates = new WeakMap<DPiWorkerSession, DPiSessionMessageState>();
let generatedSessionSequence = 0;
let generatedMessageSequence = 0;

function createDefaultRemoteSettings(thinkingLevel: ThinkingLevel): DPiInteractiveRemoteSettings {
	return {
		autoCompact: true,
		thinkingLevel,
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
	};
}

export class DPiAgentIpcServer {
	private readonly proxy: DPiLocalAgentSessionProxy;
	private readonly transport: DPiIpcTransport;
	private readonly handlers: DPiIpcMessageHandlers;
	private readonly subscribers = new Map<string, () => void>();

	constructor(proxy: DPiLocalAgentSessionProxy, transport: DPiIpcTransport, handlers: DPiIpcMessageHandlers) {
		this.proxy = proxy;
		this.transport = transport;
		this.handlers = handlers;
	}

	start(): void {
		this.transport.onMessage((message) => {
			void this.handleMessage(message);
		});
	}

	stop(): void {
		for (const unsubscribe of this.subscribers.values()) {
			unsubscribe();
		}
		this.subscribers.clear();
		this.proxy.dispose();
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (!isRecord(message) || typeof message.type !== "string") {
			return;
		}
		if (message.type === "http_query" && typeof message.requestId === "string") {
			this.handleHttpQuery(message.requestId, message.query);
			return;
		}
		if (message.type === "http_request" && typeof message.requestId === "string") {
			await this.handleHttpRequest(message.requestId, message.action, message.data);
			return;
		}
		if (message.type === "sse_subscribe" && typeof message.subscriberId === "string") {
			this.subscribeSse(message.subscriberId);
			return;
		}
		if (message.type === "sse_unsubscribe" && typeof message.subscriberId === "string") {
			this.unsubscribeSse(message.subscriberId);
		}
	}

	private handleHttpQuery(requestId: string, query: unknown): void {
		if (query === "snapshot") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getState());
			return;
		}
		if (query === "state") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getState());
			return;
		}
		if (query === "status") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getStatusState());
			return;
		}
		if (query === "realtime") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getRealtimeState());
			return;
		}
		if (query === "messages") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getState().messages);
			return;
		}
		if (query === "settings") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getState().remoteSettings);
			return;
		}
		if (query === "tree") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getTree());
			return;
		}
		if (query === "user-messages") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getUserMessagesForForking());
			return;
		}
		if (query === "sessions") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getSessions());
			return;
		}
		if (query === "client-extensions") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getClientExtensions());
			return;
		}
		if (query === "commands") {
			this.handlers.onHttpResponse(requestId, 200, this.proxy.getCommands());
			return;
		}
		this.handlers.onHttpResponse(requestId, 404, {
			ok: false,
			error: `Unknown query: ${String(query)}`,
		});
	}

	private async handleHttpRequest(requestId: string, action: unknown, data: unknown): Promise<void> {
		try {
			const payload = isRecord(data) ? data : {};
			const text = typeof payload.text === "string" ? payload.text : "";
			if (action === "prompt") {
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				void this.proxy
					.prompt(text, { images: extractImages(payload.options) ?? extractImages(payload) })
					.catch(() => {});
				return;
			}
			if (action === "steer") {
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				void this.proxy.steer(text, extractImages(payload) ?? extractImages(payload.options)).catch(() => {});
				return;
			}
			if (action === "follow-up") {
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				void this.proxy.followUp(text, extractImages(payload) ?? extractImages(payload.options)).catch(() => {});
				return;
			}
			if (action === "abort") {
				this.proxy.abort();
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "abort-bash") {
				this.proxy.abortBash();
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "clear-queue") {
				this.handlers.onHttpResponse(requestId, 200, { ok: true, dropped: this.proxy.clearQueue() });
				return;
			}
			if (action === "compact") {
				await this.proxy.compact(
					typeof payload.customInstructions === "string" ? payload.customInstructions : undefined,
				);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "set-thinking-level") {
				if (typeof payload.level !== "string") {
					this.handlers.onHttpResponse(requestId, 400, { ok: false, error: "Missing 'level'" });
					return;
				}
				this.proxy.setThinkingLevel(payload.level as ThinkingLevel);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "cycle-thinking-level") {
				this.proxy.cycleThinkingLevel(payload.direction === -1 ? -1 : 1);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "new-session") {
				await this.proxy.newSession();
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "switch-session") {
				if (typeof payload.sessionFile !== "string") {
					this.handlers.onHttpResponse(requestId, 400, { ok: false, error: "Missing 'sessionFile'" });
					return;
				}
				await this.proxy.switchSession(payload.sessionFile);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "fork") {
				await this.proxy.fork(typeof payload.entryId === "string" ? payload.entryId : undefined);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "name") {
				if (typeof payload.name !== "string") {
					this.handlers.onHttpResponse(requestId, 400, { ok: false, error: "Missing 'name'" });
					return;
				}
				this.proxy.renameSession(payload.name);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "label") {
				if (typeof payload.entryId !== "string") {
					this.handlers.onHttpResponse(requestId, 400, { ok: false, error: "Missing 'entryId'" });
					return;
				}
				this.proxy.setLabel(payload.entryId, typeof payload.label === "string" ? payload.label : undefined);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "reload") {
				await this.proxy.reload();
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			if (action === "settings") {
				this.proxy.updateSettings(payload);
				this.handlers.onHttpResponse(requestId, 200, { ok: true });
				return;
			}
			this.handlers.onHttpResponse(requestId, 404, {
				ok: false,
				error: `Unknown action: ${String(action)}`,
			});
		} catch (error) {
			const status = action === "compact" ? compactErrorHttpStatus(error) : 500;
			this.handlers.onHttpResponse(requestId, status, {
				ok: false,
				error: errorMessage(error),
			});
		}
	}

	private subscribeSse(subscriberId: string): void {
		this.unsubscribeSse(subscriberId);
		const unsubscribe = this.proxy.subscribe((event) => {
			if (event.type === "state") {
				return;
			}
			this.handlers.onSseEvent(subscriberId, event.type, event.data);
		});
		this.subscribers.set(subscriberId, unsubscribe);
		this.handlers.onSseEvent(subscriberId, "status", this.proxy.getStatusState());
		this.handlers.onSseEvent(subscriberId, "realtime", {
			type: "snapshot",
			...this.proxy.getRealtimeState(),
		});
	}

	private unsubscribeSse(subscriberId: string): void {
		const unsubscribe = this.subscribers.get(subscriberId);
		if (!unsubscribe) {
			return;
		}
		unsubscribe();
		this.subscribers.delete(subscriberId);
	}
}

export class DPiLocalAgentSessionProxy {
	private readonly runtime: DPiAgentSessionRuntime;
	private readonly steeringQueuePath: string;
	private readonly listeners = new Set<(event: DPiLocalAgentEvent) => void>();
	private readonly messages: DPiLocalAgentMessage[] = [];
	private readonly transcriptItems: DPiTranscriptItem[] = [];
	private readonly importedSessionMessageIds = new Set<string>();
	private readonly queued: DPiLocalQueueItem[] = [];
	private realtimeCursor = 0;
	private realtimePageIndex = 0;
	private realtimePage: DPiInteractiveRealtimePage = createDPiInteractiveRealtimePage("initial", 0);
	private streamingAssistantMessageId: string | undefined;
	private banner: DPiInteractiveBannerData | undefined;
	private streaming = false;
	private compacting = false;
	private thinking: ThinkingLevel | undefined;
	private sessionName: string | undefined;
	private scopedModelIds: string[] | null = null;
	private enabledModelPatterns: string[] | undefined;
	private remoteSettingsOverrides: Partial<DPiInteractiveRemoteSettings> = {};
	private tokenUsage: DPiLocalAgentState["tokenUsage"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		usingSubscription: false,
	};
	private unsubscribeSessionMessages: (() => void) | undefined;
	private messageDispatcher:
		| {
				prompt?: (
					text: string,
					options?: { images?: Array<{ url: string; mediaType?: string }> },
				) => Promise<void> | void;
				steer?: (text: string, images?: Array<{ url: string; mediaType?: string }>) => Promise<void> | void;
				followUp?: (text: string, images?: Array<{ url: string; mediaType?: string }>) => Promise<void> | void;
				compact?: (customInstructions?: string) => Promise<unknown> | unknown;
		  }
		| undefined;

	constructor(runtime: DPiAgentSessionRuntime, options: DPiLocalAgentSessionProxyOptions = {}) {
		this.runtime = runtime;
		this.steeringQueuePath =
			options.steeringQueuePath ??
			join(getSessionMetadata(runtime.session).cwd ?? tmpdir(), `.d-pi-${randomUUID()}`, "steering.jsonl");
		this.subscribeToSessionMessages();
	}

	setBanner(banner: DPiInteractiveBannerData | undefined): void {
		this.banner = banner;
		this.emitState();
	}

	setMessageDispatcher(dispatcher: {
		prompt?: (
			text: string,
			options?: { images?: Array<{ url: string; mediaType?: string }> },
		) => Promise<void> | void;
		steer?: (text: string, images?: Array<{ url: string; mediaType?: string }>) => Promise<void> | void;
		followUp?: (text: string, images?: Array<{ url: string; mediaType?: string }>) => Promise<void> | void;
		compact?: (customInstructions?: string) => Promise<unknown> | unknown;
	}): void {
		this.messageDispatcher = dispatcher;
	}

	getState(): DPiLocalAgentState {
		const metadata = getSessionMetadata(this.runtime.session);
		const extensionState = getSessionExtensionSnapshot(this.runtime.session);
		const model = metadata.model ?? getSessionExtensionState(this.runtime.session).currentModel;
		const thinkingLevel = this.thinking ?? getSessionExtensionState(this.runtime.session).thinking ?? "off";
		const remoteSettings = {
			...createDefaultRemoteSettings(thinkingLevel),
			...this.remoteSettingsOverrides,
			thinkingLevel,
		};
		return {
			model: model?.id ?? "",
			thinkingLevel,
			isStreaming: this.streaming,
			isCompacting: this.compacting,
			isBashRunning: false,
			steeringMessages: this.steeringQueueItems().map((item) => item.text),
			followUpMessages: [],
			sessionFile: metadata.path,
			sessionName: this.sessionName,
			tokenUsage: this.tokenUsage,
			contextUsage: {
				tokens: 0,
				contextWindow: model?.contextWindow ?? 0,
				percent: 0,
			},
			modelInfo: {
				id: model?.id ?? "",
				provider: model?.provider ?? "",
				reasoning: model?.reasoning ?? false,
				contextWindow: model?.contextWindow ?? 0,
			},
			autoCompactEnabled: true,
			cwd: metadata.cwd ?? "",
			availableProviderCount: this.runtime.session.modelRegistry.getAll().length,
			remoteSettings,
			scopedModelIds: this.scopedModelIds,
			enabledModelPatterns: this.enabledModelPatterns,
			extensionPaths: [],
			agent: {
				sessionId: metadata.id,
				status: this.streaming ? "busy" : "ready",
			},
			session: {
				id: metadata.id,
				...(metadata.path ? { path: metadata.path } : {}),
			},
			banner: this.banner,
			messages: [...this.messages],
			transcriptItems: [...this.transcriptItems],
			streaming: this.streaming,
			queued: this.steeringQueueItems(),
			...(this.thinking ? { thinking: this.thinking } : {}),
			extensions: extensionState,
		};
	}

	getStatusState(): DPiInteractiveStatusState {
		const { messages, transcriptItems, ...status } = this.getState();
		void messages;
		void transcriptItems;
		return status;
	}

	getRealtimeState(): DPiInteractiveRealtimeState {
		return {
			cursor: this.realtimeCursor,
			page: this.realtimePage,
			items: [...this.transcriptItems],
			messages: [...this.messages],
		};
	}

	getCommands(): DPiInteractiveSlashCommand[] {
		const extensionCommands = getSessionExtensionSnapshot(this.runtime.session).commands;
		const byName = new Map<string, DPiInteractiveSlashCommand>();
		for (const name of DPI_NATIVE_CONNECT_BUILTIN_COMMANDS) {
			byName.set(name, { name, source: "builtin" });
		}
		for (const command of extensionCommands) {
			byName.set(command.name, {
				name: command.name,
				description: command.description,
				source: "extension",
			});
		}
		return [...byName.values()];
	}

	getModels(): DPiInteractiveModelItemData[] {
		return this.runtime.session.modelRegistry.getAll().map((model) => modelToInteractiveModel(model));
	}

	getTree(): DPiInteractiveTreeNodeData[] {
		const nodes = this.messages.map((message, index): DPiInteractiveTreeNodeData => {
			const previous = this.messages[index - 1];
			return {
				id: message.id,
				type: message.role,
				parentId: previous?.id ?? null,
				timestamp: new Date(message.timestamp).toISOString(),
				preview: messageContentText(message.content).replace(/\s+/g, " ").trim(),
				content: message.content,
				children: [],
			};
		});
		const byId = new Map(nodes.map((node) => [node.id, node]));
		const roots: DPiInteractiveTreeNodeData[] = [];
		for (const node of nodes) {
			if (node.parentId) {
				byId.get(node.parentId)?.children.push(node);
			} else {
				roots.push(node);
			}
		}
		return roots;
	}

	getUserMessagesForForking(): DPiInteractiveUserMessageItem[] {
		return this.messages
			.filter((message) => message.role === "user")
			.map((message) => ({ id: message.id, text: messageContentText(message.content) }));
	}

	getSessions(): DPiInteractiveSessionItemData[] {
		const metadata = getSessionMetadata(this.runtime.session);
		const created = new Date(this.messages[0]?.timestamp ?? Date.now()).toISOString();
		const modified = new Date(this.messages.at(-1)?.timestamp ?? Date.now()).toISOString();
		return [
			{
				path: metadata.path ?? metadata.id,
				id: metadata.id,
				cwd: metadata.cwd ?? "",
				...(this.sessionName ? { name: this.sessionName } : {}),
				created,
				modified,
				messageCount: this.messages.length,
				firstMessage: messageContentText(this.messages.find((message) => message.role === "user")?.content),
			},
		];
	}

	getClientExtensions(): DPiInteractiveClientExtensionData[] {
		return [];
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const dropped = {
			steering: this.steeringQueueItems().map((item) => item.text),
			followUp: [],
		};
		clearSteeringMessagesSync(this.steeringQueuePath);
		this.emit({ type: "queue", data: { queued: [] } });
		this.emitState();
		return dropped;
	}

	async compact(customInstructions?: string): Promise<void> {
		void customInstructions;
		const startedAt = Date.now();
		this.compacting = true;
		this.emit({ type: "compaction_start" });
		this.emitState();
		try {
			const compact = this.messageDispatcher?.compact;
			if (!compact) {
				throw new Error("Compaction is not available for this agent runtime");
			}
			const result = await compact(customInstructions);
			const completedAt = Date.now();
			this.compacting = false;
			this.emit({ type: "compaction_end" });
			this.emitState();
			this.startRealtimePageWithCompactDivider(startedAt, completedAt, result);
			this.emitState();
		} catch (error) {
			this.compacting = false;
			this.emit({ type: "compaction_end" });
			this.emitState();
			throw error;
		}
	}

	setModel(modelId: string): void {
		const model = this.resolveModel(modelId);
		if (!model) {
			return;
		}
		getSessionExtensionState(this.runtime.session).currentModel = model;
		this.emitState();
	}

	cycleModel(direction: 1 | -1): void {
		const models = this.runtime.session.modelRegistry.getAll();
		if (models.length === 0) {
			return;
		}
		const state = this.getState();
		const currentIndex = models.findIndex(
			(model) => model.id === state.model || `${model.provider}/${model.id}` === state.model,
		);
		const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + models.length) % models.length;
		const next = models[nextIndex];
		if (next) {
			getSessionExtensionState(this.runtime.session).currentModel = next;
			this.emitState();
		}
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.thinking = level;
		getSessionExtensionState(this.runtime.session).thinking = level;
		this.emit({ type: "state", data: this.getState() });
	}

	cycleThinkingLevel(direction: 1 | -1): void {
		const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];
		const current = this.thinking ?? getSessionExtensionState(this.runtime.session).thinking ?? "off";
		const currentIndex = levels.indexOf(current);
		const next =
			levels[(currentIndex < 0 ? 0 : currentIndex + direction + levels.length) % levels.length] ?? "medium";
		this.setThinkingLevel(next);
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.remoteSettingsOverrides = { ...this.remoteSettingsOverrides, autoCompact: enabled };
		this.emitState();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.remoteSettingsOverrides = { ...this.remoteSettingsOverrides, steeringMode: mode };
		this.emitState();
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.remoteSettingsOverrides = { ...this.remoteSettingsOverrides, followUpMode: mode };
		this.emitState();
	}

	async newSession(): Promise<void> {
		await this.runtime.newSession();
	}

	async switchSession(sessionFile: string): Promise<void> {
		await this.runtime.switchSession(sessionFile);
	}

	async fork(entryId?: string): Promise<void> {
		await this.runtime.fork(entryId ?? "");
	}

	renameSession(name: string): void {
		this.sessionName = name;
		this.emit({ type: "state", data: this.getState() });
	}

	setLabel(entryId: string, label: string | undefined): void {
		const node = this.messages.find((message) => message.id === entryId);
		if (node) {
			node.details = { ...(isRecord(node.details) ? node.details : {}), label };
			this.emitRealtimeUpsert(node);
		}
		this.emitState();
	}

	setScopedModels(enabledIds: string[] | null): void {
		this.scopedModelIds = enabledIds;
		this.emitState();
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.enabledModelPatterns = patterns;
		this.emitState();
	}

	async reload(): Promise<void> {
		await this.runtime.session.reload();
		this.emitState();
	}

	updateSettings(updates: Record<string, unknown>): void {
		this.remoteSettingsOverrides = { ...this.remoteSettingsOverrides, ...remoteSettingsUpdates(updates) };
		if (typeof updates.autoCompact === "boolean") {
			this.setAutoCompactEnabled(updates.autoCompact);
		}
		if (updates.steeringMode === "all" || updates.steeringMode === "one-at-a-time") {
			this.setSteeringMode(updates.steeringMode);
		}
		if (updates.followUpMode === "all" || updates.followUpMode === "one-at-a-time") {
			this.setFollowUpMode(updates.followUpMode);
		}
		if (typeof updates.thinkingLevel === "string") {
			this.setThinkingLevel(updates.thinkingLevel as ThinkingLevel);
		}
		this.emitState();
	}

	subscribe(listener: (event: DPiLocalAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	applyRuntimeEvent(event: DPiRuntimeEvent): void {
		if (event.type === "agent_start") {
			this.streaming = true;
			this.streamingAssistantMessageId = undefined;
			this.emit({ type: "agent_start", data: { type: "agent_start" } });
			this.emitState();
			return;
		}
		if (event.type === "agent_end") {
			this.streaming = false;
			this.emit({ type: "agent_end", data: { type: "agent_end" } });
			this.emitState();
			return;
		}
		if (event.type === "assistant_stream") {
			if (!event.done) {
				this.streaming = true;
			}
			if (event.done && event.message) {
				this.updateTokenUsage(event);
				this.upsertStreamingAssistantMessage(event.message, true);
			} else {
				if (event.message) {
					this.upsertStreamingAssistantMessage(event.message, false);
				}
				this.emitState();
			}
			return;
		}
		if (event.type === "message") {
			this.recordSessionMessage(runtimeMessageToLocalMessage(event.message), true);
			return;
		}
		if (event.type === "tool_start") {
			this.upsertToolCallMessage(event.tool.id, event.tool.name, event.tool.args);
			this.emitRealtimeItemUpsert({
				id: `tool-state-${event.tool.id}`,
				type: "tool_state",
				toolCallId: event.tool.id,
				toolName: event.tool.name,
				status: "running",
				args: event.tool.args,
				timestamp: event.tool.startedAt,
			});
			this.emit({
				type: "tool_execution_start",
				data: {
					type: "tool_execution_start",
					toolCallId: event.tool.id,
					toolName: event.tool.name,
					args: event.tool.args,
				},
			});
			this.emitState();
			return;
		}
		if (event.type === "tool_update") {
			this.emit({
				type: "tool_execution_update",
				data: {
					type: "tool_execution_update",
					toolCallId: event.toolCallId,
					partialResult: event.details ?? { content: [{ type: "text", text: event.message ?? "" }] },
				},
			});
			this.emitState();
			return;
		}
		if (event.type === "tool_end") {
			this.upsertToolResultMessage(event);
			this.emitRealtimeItemUpsert({
				id: `tool-state-${event.toolCallId}`,
				type: "tool_state",
				toolCallId: event.toolCallId,
				toolName: event.toolName ?? event.toolCallId,
				status: event.status,
				...(event.result === undefined ? {} : { result: event.result }),
				...(event.error === undefined ? {} : { error: event.error }),
				timestamp: event.endedAt,
			});
			this.emit({
				type: "tool_execution_end",
				data: {
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					result: event.result ?? { content: [{ type: "text", text: event.error ?? "" }] },
					isError: event.status === "failed" || event.status === "cancelled",
				},
			});
			this.emitState();
			return;
		}
		if (event.type === "queue_update") {
			this.emit({ type: "queue", data: { queued: this.steeringQueueItems() } });
			this.emitState();
			return;
		}
		if (event.type === "turn_stats") {
			this.emitRealtimeItemUpsert({
				id: nextGeneratedId("turn-stats"),
				type: "turn_stats",
				tps: event.tps,
				output: event.output,
				input: event.input,
				cacheRead: event.cacheRead,
				cacheWrite: event.cacheWrite,
				total: event.total,
				duration: event.duration,
				timestamp: Date.now(),
			});
			this.emit({ type: "turn_stats", data: event });
			return;
		}
		if (event.type === "state_update") {
			if (event.state.thinking?.level) {
				this.thinking = event.state.thinking.level;
			}
			this.emitState();
			return;
		}
		if (event.type === "session_replaced") {
			this.startRealtimePage("resume", { emit: false });
			this.importedSessionMessageIds.clear();
			if (event.transcriptItems) {
				this.transcriptItems.splice(0, this.transcriptItems.length, ...event.transcriptItems);
			}
			for (const message of runtimeMessagesToLocalCurrentPageMessages(event.messages)) {
				this.recordSessionMessage(message, false, { recordTranscript: !event.transcriptItems });
			}
			this.emitRealtimeSnapshot();
			this.emit({ type: "resume", data: this.getState() });
			this.emitState();
			return;
		}
		if (event.type === "error") {
			this.recordSessionMessage(
				{
					id: nextGeneratedId("message"),
					role: "custom",
					customType: "runtime-error",
					content: event.error.message,
					timestamp: Date.now(),
				},
				true,
			);
		}
	}

	private updateTokenUsage(event: Extract<DPiRuntimeEvent, { type: "assistant_stream" }>): void {
		const usage = event.message && "usage" in event.message ? event.message.usage : undefined;
		if (!usage) {
			return;
		}
		const input = numberField(usage, "input");
		const output = numberField(usage, "output");
		const cacheRead = numberField(usage, "cacheRead");
		const cacheWrite = numberField(usage, "cacheWrite");
		const costRecord = objectField(usage, "cost");
		this.tokenUsage = {
			input,
			output,
			cacheRead,
			cacheWrite,
			cost: costRecord ? numberField(costRecord, "total") : 0,
			usingSubscription: false,
			...(cacheRead + cacheWrite > 0
				? { latestCacheHitRate: (cacheRead / Math.max(1, input + cacheRead + cacheWrite)) * 100 }
				: {}),
		};
	}

	async prompt(text: string, options?: { images?: Array<{ url: string; mediaType?: string }> }): Promise<void> {
		if (this.streaming) {
			await this.steer(text, options?.images);
			return;
		}
		const prompt = this.messageDispatcher?.prompt;
		if (prompt) {
			this.streaming = true;
		}
		this.recordLocalInput("prompt", text, options?.images);
		try {
			await dispatchSessionInputHandlers(this.runtime.session, text, "next");
			await prompt?.(text, options);
		} catch (error) {
			if (prompt) {
				this.streaming = false;
				this.emitState();
			}
			throw error;
		} finally {
			if (prompt && this.streaming) {
				this.streaming = false;
				this.emitState();
			}
		}
	}

	async steer(text: string, images?: Array<{ url: string; mediaType?: string }>): Promise<void> {
		await dispatchSessionInputHandlers(this.runtime.session, text, "steer");
		await appendSteeringMessage(this.steeringQueuePath, {
			text,
			source: "connect",
			...(images ? { images } : {}),
		});
		this.emit({ type: "queue", data: { queued: this.steeringQueueItems() } });
		this.emitState();
	}

	async followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): Promise<void> {
		await this.steer(text, images);
	}

	abort(): void {
		this.streaming = false;
		this.emit({ type: "agent_end", data: { type: "agent_end" } });
		this.emitState();
	}

	abortBash(): void {
		this.emitState();
	}

	resubscribe(reason: "new" | "resume" | "fork"): void {
		this.subscribeToSessionMessages();
		this.emit({ type: reason, data: this.getState() });
		this.emitState();
	}

	dispose(): void {
		this.unsubscribeSessionMessages?.();
		this.unsubscribeSessionMessages = undefined;
		this.listeners.clear();
	}

	private subscribeToSessionMessages(): void {
		this.unsubscribeSessionMessages?.();
		const messageState = getSessionMessageState(this.runtime.session);
		for (const message of messageState.messages) {
			this.recordSessionMessage(message, false);
		}
		this.unsubscribeSessionMessages = subscribeSessionMessages(this.runtime.session, (message) => {
			this.recordSessionMessage(message, true);
		});
	}

	private recordSessionMessage(
		message: DPiLocalAgentMessage,
		emitEvents: boolean,
		options: { recordTranscript?: boolean } = {},
	): void {
		if (this.importedSessionMessageIds.has(message.id)) {
			return;
		}
		this.importedSessionMessageIds.add(message.id);
		this.messages.push(message);
		if (options.recordTranscript !== false) {
			this.upsertTranscriptItem(localMessageToTranscriptItem(message));
		}
		const cursor = this.bumpRealtimeCursor();
		if (emitEvents) {
			this.emit({
				type: "realtime",
				data: { type: "upsert", cursor, item: localMessageToTranscriptItem(message), message },
			});
			this.emit({ type: "message", data: message });
			this.emitState();
		}
	}

	private resolveModel(modelId: string): Model<Api> | undefined {
		if (modelId.includes("/")) {
			const slashIndex = modelId.indexOf("/");
			return this.runtime.session.modelRegistry.find(modelId.slice(0, slashIndex), modelId.slice(slashIndex + 1));
		}
		return this.runtime.session.modelRegistry.getAll().find((model) => model.id === modelId);
	}

	private upsertStreamingAssistantMessage(message: DPiAgentMessage, emitEvents: boolean): void {
		if (message.role !== "assistant") {
			return;
		}
		const id = this.streamingAssistantMessageId ?? nextGeneratedId("message");
		this.streamingAssistantMessageId = emitEvents ? undefined : id;
		const localMessage: DPiLocalAgentMessage = {
			id,
			role: "assistant",
			content: "content" in message ? message.content : "",
			timestamp: message.timestamp ?? Date.now(),
		};
		const existingIndex = this.messages.findIndex((candidate) => candidate.id === id);
		if (existingIndex >= 0) {
			this.messages[existingIndex] = localMessage;
		} else {
			this.messages.push(localMessage);
		}
		this.emitRealtimeUpsert(localMessage);
		if (emitEvents) {
			this.emit({ type: "message", data: localMessage });
		}
		this.emitState();
	}

	private upsertToolCallMessage(toolCallId: string, toolName: string, args: unknown): void {
		const existingIndex = this.messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some(
					(part) =>
						typeof part === "object" &&
						part !== null &&
						"type" in part &&
						part.type === "toolCall" &&
						"id" in part &&
						part.id === toolCallId,
				),
		);
		const toolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: args };
		if (existingIndex >= 0) {
			const existing = this.messages[existingIndex];
			const content = Array.isArray(existing.content) ? existing.content : [];
			const message = {
				...existing,
				content: content.map((part) =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "toolCall" &&
					"id" in part &&
					part.id === toolCallId
						? toolCall
						: part,
				),
			};
			this.messages[existingIndex] = message;
			this.emitRealtimeUpsert(message);
			return;
		}
		const message: DPiLocalAgentMessage = {
			id: nextGeneratedId("message"),
			role: "assistant",
			content: [toolCall],
			timestamp: Date.now(),
		};
		this.messages.push(message);
		this.emitRealtimeUpsert(message);
	}

	private upsertToolResultMessage(event: Extract<DPiRuntimeEvent, { type: "tool_end" }>): void {
		const isError = event.status === "failed" || event.status === "cancelled";
		const resultMessage: DPiLocalAgentMessage = {
			id: `tool-result-${event.toolCallId}`,
			role: "toolResult",
			toolCallId: event.toolCallId,
			...(event.result && typeof event.result === "object" && "toolName" in event.result
				? { toolName: String((event.result as { toolName?: unknown }).toolName) }
				: {}),
			content: toolResultContent(event.result, event.error ?? ""),
			...(toolResultDetails(event.result) === undefined ? {} : { details: toolResultDetails(event.result) }),
			...(isError ? { isError: true } : {}),
			timestamp: event.endedAt,
		};
		const existingIndex = this.messages.findIndex(
			(message) => message.role === "toolResult" && message.toolCallId === event.toolCallId,
		);
		if (existingIndex >= 0) {
			this.messages[existingIndex] = resultMessage;
		} else {
			this.messages.push(resultMessage);
		}
		this.emitRealtimeUpsert(resultMessage);
	}

	private recordLocalInput(
		kind: DPiLocalQueueItem["kind"],
		text: string,
		images?: Array<{ url: string; mediaType?: string }>,
	): void {
		const queueItem: DPiLocalQueueItem = {
			id: nextGeneratedId("queue"),
			kind,
			text,
			...(images ? { images } : {}),
			timestamp: Date.now(),
		};
		this.queued.push(queueItem);
		this.emit({ type: "queue", data: { queued: [...this.queued] } });
		this.emitState();

		if (kind === "prompt") {
			const queuedIndex = this.queued.findIndex((candidate) => candidate.id === queueItem.id);
			if (queuedIndex >= 0) {
				this.queued.splice(queuedIndex, 1);
			}
		}
		this.emitState();
	}

	private emitState(): void {
		this.emit({ type: "status", data: this.getStatusState() });
		this.emit({ type: "state", data: this.getState() });
	}

	private bumpRealtimeCursor(): number {
		this.realtimeCursor += 1;
		return this.realtimeCursor;
	}

	private startRealtimePage(reason: DPiInteractiveRealtimePageReason, options: { emit?: boolean } = {}): void {
		this.realtimePageIndex += 1;
		this.realtimePage = createDPiInteractiveRealtimePage(reason, this.realtimePageIndex);
		this.realtimeCursor = 0;
		this.messages.splice(0, this.messages.length);
		this.transcriptItems.splice(0, this.transcriptItems.length);
		this.streamingAssistantMessageId = undefined;
		if (options.emit !== false) {
			this.emitRealtimeSnapshot();
		}
	}

	private startRealtimePageWithCompactDivider(startedAt: number, completedAt: number, result: unknown): void {
		this.startRealtimePage("compact", { emit: false });
		const divider = compactDividerFromResult(result, startedAt, completedAt);
		const message: DPiLocalAgentMessage = {
			id: nextGeneratedId("message"),
			role: "custom",
			customType: "compact-divider",
			display: true,
			content: divider.label,
			details: divider.details,
			timestamp: completedAt,
		};
		this.messages.push(message);
		this.emitRealtimeUpsert(message);
	}

	private emitRealtimeUpsert(message: DPiLocalAgentMessage): void {
		const item = localMessageToTranscriptItem(message);
		this.upsertTranscriptItem(item);
		this.emit({ type: "realtime", data: { type: "upsert", cursor: this.bumpRealtimeCursor(), item, message } });
	}

	private emitRealtimeItemUpsert(item: DPiTranscriptItem): void {
		this.upsertTranscriptItem(item);
		this.emit({ type: "realtime", data: { type: "upsert", cursor: this.bumpRealtimeCursor(), item } });
	}

	private emitRealtimeSnapshot(): void {
		this.emit({ type: "realtime", data: { type: "snapshot", ...this.getRealtimeState() } });
	}

	private upsertTranscriptItem(item: DPiTranscriptItem): void {
		const index = this.transcriptItems.findIndex((candidate) => candidate.id === item.id);
		if (index < 0) {
			this.transcriptItems.push(item);
			return;
		}
		this.transcriptItems[index] = item;
	}

	private steeringQueueItems(): DPiLocalQueueItem[] {
		return readSteeringMessagesSync(this.steeringQueuePath).map((message): DPiLocalQueueItem => {
			return {
				id: message.id,
				kind: "steer",
				text: message.text,
				...(message.images ? { images: message.images } : {}),
				timestamp: message.createdAt,
			};
		});
	}

	private emit(event: DPiLocalAgentEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function createPlaceholderSession(
	services: DPiAgentSessionServices,
	sessionManager: DPiWorkerSessionManager,
	model: Model<Api> | undefined,
): DPiWorkerSession {
	const resourceLoader = createEmptyResourceLoader(services.resourceLoaderOptions);
	const modelRegistry = services.modelRegistry ?? createEmptyModelRegistry();
	const extensionState = createEmptyExtensionState(services.settingsManager);
	let lastBindOptions: DPiBindExtensionsOptions | undefined;
	const session: DPiWorkerSession = {
		agent: {
			waitForIdle: async () => {},
		},
		resourceLoader,
		modelRegistry,
		getToolDefinitions: () => getSessionExtensionState(session).toolDefinitions.map((tool) => ({ ...tool })),
		reload: async () => {
			await resourceLoader.reload();
			if (lastBindOptions) {
				await session.bindExtensions(lastBindOptions);
			}
		},
		bindExtensions: async (bindOptions) => {
			lastBindOptions = bindOptions;
			resetExtensionState(extensionState, services.settingsManager);
			for (const extension of services.resourceLoaderOptions?.extensionFactories ?? []) {
				try {
					extension.factory(createExtensionApi(extensionState, getSessionMessageState(session)));
				} catch (error) {
					bindOptions.onError({ extensionPath: extension.name, error });
				}
			}
		},
		navigateTree: async () => ({ cancelled: false }),
	};
	sessionExtensionStates.set(session, extensionState);
	sessionMetadata.set(session, {
		id: nextGeneratedId("session"),
		...(services.cwd ? { cwd: services.cwd } : {}),
		...(sessionManager.sessionDir ? { path: sessionManager.sessionDir } : {}),
		...(model ? { model } : {}),
	});
	return session;
}

interface PiSettings {
	defaultThinkingLevel?: ThinkingLevel;
}

function createSettingsManager(cwd: string): DPiWorkerSettingsManager {
	void cwd;
	const settings: PiSettings = {};
	return {
		getDefaultThinkingLevel: () => settings.defaultThinkingLevel,
	};
}

function createBuiltInModelRegistry(agentDefinition?: LoadedAgentDefinition): DPiWorkerModelRegistry {
	let registry = loadAvailableModels(agentDefinition);
	return {
		find: (provider, modelId) => findBuiltInModel(registry.models, provider, modelId),
		getAll: () => [...registry.models],
		getAvailable: async () => [...registry.models],
		getApiKeyAndHeaders: (model) => {
			const config = registry.providerAuth.get(model.provider);
			if (!config?.apiKey) {
				return undefined;
			}
			const headers = {
				...(config?.authHeader && config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
				...(config.headers ?? {}),
			};
			return {
				apiKey: config.apiKey,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			};
		},
		refresh: () => {
			registry = loadAvailableModels(agentDefinition);
		},
	};
}

function findBuiltInModel(models: Model<Api>[], provider: string, modelId: string): Model<Api> | undefined {
	const aliasedModelId = `${provider}/${modelId}`;
	return models.find((model) => (model.provider === provider && model.id === modelId) || model.id === aliasedModelId);
}

interface DPiProviderAuthConfig {
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
}

interface DPiAvailableModels {
	models: Model<Api>[];
	providerAuth: Map<string, DPiProviderAuthConfig>;
}

function loadAvailableModels(agentDefinition?: LoadedAgentDefinition): DPiAvailableModels {
	const agentLocal = loadAgentLocalModels(agentDefinition);
	return {
		models: agentLocal.models,
		providerAuth: agentLocal.providerAuth,
	};
}

function loadAgentLocalModels(agentDefinition: LoadedAgentDefinition | undefined): DPiAvailableModels {
	if (!agentDefinition) {
		return { models: [], providerAuth: new Map() };
	}
	const providerAuth = new Map<string, DPiProviderAuthConfig>();
	const models: Model<Api>[] = [];
	for (const definition of agentLocalModelDefinitions(agentDefinition)) {
		const provider = resolveAgentModelProvider(definition.provider);
		if (!provider) {
			continue;
		}
		providerAuth.set(provider.provider, {
			...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
			...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
			...(provider.headers === undefined ? {} : { headers: { ...provider.headers } }),
		});
		models.push(agentLocalModelToPiModel(definition, provider));
	}
	return { models, providerAuth };
}

function agentLocalModelDefinitions(agentDefinition: LoadedAgentDefinition): AgentLocalModelDefinition[] {
	const definitions: AgentLocalModelDefinition[] = [];
	for (const candidate of [agentDefinition.model]) {
		if (candidate && isAgentLocalModelDefinition(candidate)) {
			definitions.push(candidate);
		}
	}
	return definitions;
}

function isAgentLocalModelDefinition(model: AgentModelDefinition): model is AgentLocalModelDefinition {
	return "id" in model;
}

function resolveAgentModelProvider(
	provider: AgentLocalModelDefinition["provider"],
): AgentProviderDefinition | undefined {
	if (typeof provider !== "string") {
		return provider;
	}
	if (provider === "openai") {
		return {
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
		};
	}
	if (provider === "anthropic") {
		return {
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
		};
	}
	return undefined;
}

function agentLocalModelToPiModel(
	definition: AgentLocalModelDefinition,
	provider: AgentProviderDefinition,
): Model<Api> {
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: provider.api,
		provider: provider.provider,
		baseUrl: provider.baseUrl,
		reasoning: definition.reasoning ?? false,
		...(definition.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...definition.thinkingLevelMap } }),
		input: definition.input ? [...definition.input] : ["text"],
		cost: definition.cost ? { ...definition.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow,
		maxTokens: definition.maxTokens ?? definition.contextWindow,
		headers: mergeHeaders(provider.headers, definition.headers),
		...(definition.compat === undefined
			? provider.compat === undefined
				? {}
				: { compat: provider.compat }
			: { compat: definition.compat }),
	};
}

function mergeHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!providerHeaders && !modelHeaders) {
		return undefined;
	}
	return { ...(providerHeaders ?? {}), ...(modelHeaders ?? {}) };
}

function createEmptyModelRegistry(): DPiWorkerModelRegistry {
	return {
		find: () => undefined,
		getAll: () => [],
		getAvailable: async () => [],
		refresh: () => {},
	};
}

function createEmptyResourceLoader(options?: DPiAgentSessionServices["resourceLoaderOptions"]): ResourceLoader {
	return {
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => options?.appendSystemPromptOverride?.([]) ?? [],
		getAgentsFiles: () => options?.agentsFilesOverride?.({ agentsFiles: [] }) ?? { agentsFiles: [] },
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
		extendResources: () => {},
		reload: async () => {},
	};
}

function createEmptyExtensionState(settingsManager?: DPiWorkerSettingsManager): DPiSessionExtensionState {
	const thinking = settingsManager?.getDefaultThinkingLevel();
	return {
		tools: [],
		commands: [],
		renderers: [],
		inputHandlers: 0,
		eventHandlers: [],
		toolDefinitions: [],
		commandDefinitions: [],
		messageRenderers: [],
		inputHandlerDefinitions: [],
		eventHandlerDefinitions: [],
		...(thinking ? { thinking } : {}),
	};
}

function resetExtensionState(state: DPiSessionExtensionState, settingsManager?: DPiWorkerSettingsManager): void {
	state.tools = [];
	state.commands = [];
	state.renderers = [];
	state.inputHandlers = 0;
	state.eventHandlers = [];
	state.toolDefinitions = [];
	state.commandDefinitions = [];
	state.messageRenderers = [];
	state.inputHandlerDefinitions = [];
	state.eventHandlerDefinitions = [];
	state.currentModel = undefined;
	state.thinking = settingsManager?.getDefaultThinkingLevel();
}

function createExtensionApi(state: DPiSessionExtensionState, messages: DPiSessionMessageState): ExtensionAPI {
	const registerExtensionHandler = ((event: string, handler: ExtensionHandler): void => {
		if (event === "input") {
			state.inputHandlerDefinitions.push(handler as ExtensionHandler<InputEvent, InputEventResult>);
			state.inputHandlers = state.inputHandlerDefinitions.length;
			return;
		}
		state.eventHandlerDefinitions.push({ event, handler });
		state.eventHandlers = state.eventHandlerDefinitions.map((candidate) => candidate.event);
	}) as ExtensionAPI["on"];

	return {
		registerTool(tool) {
			state.toolDefinitions.push(tool);
			state.tools.push({
				name: tool.name,
				label: tool.label,
				description: tool.description,
			});
		},
		registerCommand(name, command) {
			state.commandDefinitions.push({ name, description: command.description, handler: command.handler });
			state.commands.push({ name, description: command.description });
		},
		registerMessageRenderer(customType, renderer) {
			state.messageRenderers.push({ customType, renderer: renderer as MessageRenderer<unknown> });
			state.renderers.push(customType);
		},
		on: registerExtensionHandler,
		sendMessage(message) {
			appendSessionMessage(messages, toLocalAgentMessage(message));
		},
		setModel(model) {
			state.currentModel = model;
			return true;
		},
		getThinkingLevel() {
			return state.thinking ?? "medium";
		},
		setThinkingLevel(level) {
			state.thinking = level;
		},
	};
}

async function dispatchSessionInputHandlers(
	session: DPiWorkerSession,
	text: string,
	streamingBehavior: InputEvent["streamingBehavior"],
): Promise<boolean> {
	const state = getSessionExtensionState(session);
	if (state.inputHandlerDefinitions.length === 0) {
		return false;
	}
	const metadata = getSessionMetadata(session);
	const event: InputEvent = {
		type: "input",
		text,
		source: "programmatic",
		...(streamingBehavior ? { streamingBehavior } : {}),
	};
	const context = {
		cwd: metadata.cwd ?? metadata.path ?? "",
		hasUI: false,
		modelRegistry: session.modelRegistry,
	};
	for (const handler of state.inputHandlerDefinitions) {
		const result = await handler(event, context);
		if (result?.action === "handled") {
			return true;
		}
	}
	return false;
}

function getSessionMessageState(session: DPiWorkerSession): DPiSessionMessageState {
	const existing = sessionMessageStates.get(session);
	if (existing) {
		return existing;
	}
	const state: DPiSessionMessageState = {
		messages: [],
		listeners: new Set(),
	};
	sessionMessageStates.set(session, state);
	return state;
}

function subscribeSessionMessages(
	session: DPiWorkerSession,
	listener: (message: DPiLocalAgentMessage) => void,
): () => void {
	const state = getSessionMessageState(session);
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

function appendSessionMessage(state: DPiSessionMessageState, message: DPiLocalAgentMessage): void {
	state.messages.push(message);
	for (const listener of state.listeners) {
		listener(message);
	}
}

function toLocalAgentMessage(message: ExtensionMessage): DPiLocalAgentMessage {
	return {
		id: nextGeneratedId("message"),
		role: toLocalAgentMessageRole(message),
		content: message.content,
		...(message.customType ? { customType: message.customType } : {}),
		...(message.display === undefined ? {} : { display: message.display }),
		...(message.details === undefined ? {} : { details: message.details }),
		timestamp: message.timestamp ?? Date.now(),
	};
}

function runtimeMessageToLocalMessage(message: DPiAgentMessage): DPiLocalAgentMessage {
	if (message.role === "compactionSummary") {
		return {
			id: nextGeneratedId("message"),
			role: "custom",
			customType: "compact-divider",
			display: true,
			content: "Compact completed",
			details: {
				tokensBefore: message.tokensBefore,
				summary: message.summary,
			},
			timestamp: message.timestamp ?? Date.now(),
		};
	}
	const metaMessage = dPiMetaMessageToLocalMessage(message);
	if (metaMessage) {
		return metaMessage;
	}
	return {
		id: nextGeneratedId("message"),
		role:
			message.role === "assistant" || message.role === "custom" || message.role === "toolResult"
				? message.role
				: "user",
		content: "content" in message ? message.content : "",
		...("customType" in message && message.customType ? { customType: message.customType } : {}),
		...("display" in message && message.display === undefined
			? {}
			: "display" in message
				? { display: message.display }
				: {}),
		...("details" in message && message.details === undefined
			? {}
			: "details" in message
				? { details: message.details }
				: {}),
		...("toolCallId" in message && typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
		...("toolName" in message && typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
		...("isError" in message && message.isError ? { isError: true } : {}),
		timestamp: message.timestamp ?? Date.now(),
	};
}

function dPiMetaMessageToLocalMessage(message: DPiAgentMessage): DPiLocalAgentMessage | undefined {
	if (!("content" in message)) {
		return undefined;
	}
	const extracted = extractDPiMeta(message.content);
	if (!extracted) {
		return undefined;
	}
	return {
		id: nextGeneratedId("message"),
		role: "custom",
		customType: "d-pi-message",
		display: true,
		content: message.content,
		details: extracted.meta,
		timestamp: message.timestamp ?? Date.now(),
	};
}

function runtimeMessagesToLocalCurrentPageMessages(messages: readonly DPiAgentMessage[]): DPiLocalAgentMessage[] {
	return messages.map((message) => runtimeMessageToLocalMessage(message));
}

function localMessageToTranscriptItem(message: DPiLocalAgentMessage): DPiTranscriptItem {
	if (message.role === "custom" && message.customType === "compact-divider") {
		const details = isRecord(message.details) ? message.details : {};
		return {
			id: message.id,
			type: "boundary",
			version: 1,
			reason: "compact",
			label: typeof message.content === "string" ? message.content : "Compact completed",
			...(typeof details.summary === "string" ? { summary: details.summary } : {}),
			...(typeof details.tokensBefore === "number" ? { tokensBefore: details.tokensBefore } : {}),
			...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
			...(typeof details.completedAt === "number" ? { completedAt: details.completedAt } : {}),
			timestamp: message.timestamp,
		};
	}
	if (message.role === "custom" && message.customType === "runtime-error") {
		return {
			id: message.id,
			type: "notice",
			level: "error",
			text: typeof message.content === "string" ? message.content : messageContentText(message.content),
			timestamp: message.timestamp,
		};
	}
	return {
		id: message.id,
		type: "message",
		message: localMessageToAgentMessage(message),
		timestamp: message.timestamp,
	};
}

function localMessageToAgentMessage(message: DPiLocalAgentMessage): DPiAgentMessage {
	return {
		role: message.role,
		content: message.content,
		...(message.customType === undefined ? {} : { customType: message.customType }),
		...(message.display === undefined ? {} : { display: message.display }),
		...(message.details === undefined ? {} : { details: message.details }),
		...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
		...(message.toolName === undefined ? {} : { toolName: message.toolName }),
		...(message.isError === undefined ? {} : { isError: message.isError }),
		timestamp: message.timestamp,
	} as DPiAgentMessage;
}

function compactDividerFromResult(
	result: unknown,
	startedAt: number,
	completedAt: number,
): { label: string; details: Record<string, unknown> } {
	const durationMs = completedAt - startedAt;
	const fallback = {
		label: `Compact completed ${Math.max(1, Math.ceil(durationMs / 1000))}s`,
		details: {
			durationMs,
			completedAt,
			...compactDividerDetails(result),
			result,
		},
	};
	if (typeof result !== "object" || result === null) {
		return fallback;
	}
	const record = result as Record<string, unknown>;
	if (typeof record.divider !== "object" || record.divider === null) {
		return fallback;
	}
	const divider = record.divider as Record<string, unknown>;
	if (typeof divider.label !== "string") {
		return fallback;
	}
	return {
		label: divider.label,
		details:
			typeof divider.details === "object" && divider.details !== null && !Array.isArray(divider.details)
				? { ...(divider.details as Record<string, unknown>), result }
				: fallback.details,
	};
}

function compactDividerDetails(result: unknown): Record<string, unknown> {
	if (typeof result !== "object" || result === null) {
		return {};
	}
	const record = result as Record<string, unknown>;
	return {
		...(typeof record.summary === "string" ? { summary: record.summary } : {}),
		...(typeof record.tokensBefore === "number" ? { tokensBefore: record.tokensBefore } : {}),
	};
}

function compactErrorHttpStatus(error: unknown): number {
	const message = errorMessage(error);
	if (
		message === "Already compacted" ||
		message === "Nothing to compact (session too small)" ||
		message === "Compaction cancelled" ||
		message.includes("Compaction is not available")
	) {
		return 400;
	}
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (code === "auth") {
			return 401;
		}
		if (code === "missing_model" || code === "invalid_session" || code === "invalid_argument") {
			return 400;
		}
		if (code === "aborted") {
			return 400;
		}
		if (code === "network" || code === "summarization_failed") {
			return 502;
		}
	}
	return 500;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") {
			return message;
		}
	}
	return String(error);
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "object" && field !== null && !Array.isArray(field)
		? (field as Record<string, unknown>)
		: undefined;
}

function numberField(value: unknown, key: string): number {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return 0;
	}
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "number" ? field : 0;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
					? part.text
					: "",
			)
			.join("");
	}
	if (content === undefined || content === null) {
		return "";
	}
	return JSON.stringify(content);
}

function modelToInteractiveModel(model: Model<Api>): DPiInteractiveModelItemData {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		cost: { ...model.cost },
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		input: [...model.input],
	};
}

function remoteSettingsUpdates(updates: Record<string, unknown>): Partial<DPiInteractiveRemoteSettings> {
	const result: Partial<DPiInteractiveRemoteSettings> = {};
	if (typeof updates.autoCompact === "boolean") {
		result.autoCompact = updates.autoCompact;
	}
	if (typeof updates.showImages === "boolean") {
		result.showImages = updates.showImages;
	}
	if (typeof updates.imageWidthCells === "number") {
		result.imageWidthCells = updates.imageWidthCells;
	}
	if (typeof updates.autoResizeImages === "boolean") {
		result.autoResizeImages = updates.autoResizeImages;
	}
	if (typeof updates.blockImages === "boolean") {
		result.blockImages = updates.blockImages;
	}
	if (typeof updates.enableSkillCommands === "boolean") {
		result.enableSkillCommands = updates.enableSkillCommands;
	}
	if (updates.steeringMode === "all" || updates.steeringMode === "one-at-a-time") {
		result.steeringMode = updates.steeringMode;
	}
	if (updates.followUpMode === "all" || updates.followUpMode === "one-at-a-time") {
		result.followUpMode = updates.followUpMode;
	}
	if (typeof updates.transport === "string") {
		result.transport = updates.transport;
	}
	if (typeof updates.httpIdleTimeoutMs === "number") {
		result.httpIdleTimeoutMs = updates.httpIdleTimeoutMs;
	}
	if (typeof updates.currentTheme === "string") {
		result.currentTheme = updates.currentTheme;
	}
	if (Array.isArray(updates.availableThemes)) {
		result.availableThemes = updates.availableThemes.filter(isString);
	}
	if (typeof updates.hideThinkingBlock === "boolean") {
		result.hideThinkingBlock = updates.hideThinkingBlock;
	}
	if (typeof updates.collapseChangelog === "boolean") {
		result.collapseChangelog = updates.collapseChangelog;
	}
	if (typeof updates.enableInstallTelemetry === "boolean") {
		result.enableInstallTelemetry = updates.enableInstallTelemetry;
	}
	if (typeof updates.treeFilterMode === "string") {
		result.treeFilterMode = updates.treeFilterMode;
	}
	if (typeof updates.showHardwareCursor === "boolean") {
		result.showHardwareCursor = updates.showHardwareCursor;
	}
	if (typeof updates.editorPaddingX === "number") {
		result.editorPaddingX = updates.editorPaddingX;
	}
	if (typeof updates.autocompleteMaxVisible === "number") {
		result.autocompleteMaxVisible = updates.autocompleteMaxVisible;
	}
	if (typeof updates.quietStartup === "boolean") {
		result.quietStartup = updates.quietStartup;
	}
	if (typeof updates.clearOnShrink === "boolean") {
		result.clearOnShrink = updates.clearOnShrink;
	}
	if (typeof updates.showTerminalProgress === "boolean") {
		result.showTerminalProgress = updates.showTerminalProgress;
	}
	if (isRecord(updates.warnings)) {
		result.warnings = updates.warnings;
	}
	return result;
}

function toLocalAgentMessageRole(message: ExtensionMessage): DPiLocalAgentMessage["role"] {
	if (message.role === "assistant" || message.role === "custom" || message.role === "user") {
		return message.role;
	}
	return message.customType ? "custom" : "assistant";
}

function getSessionExtensionState(session: DPiWorkerSession): DPiSessionExtensionState {
	const existing = sessionExtensionStates.get(session);
	if (existing) {
		return existing;
	}
	const state = createEmptyExtensionState();
	sessionExtensionStates.set(session, state);
	return state;
}

function getSessionExtensionSnapshot(session: DPiWorkerSession): DPiSessionExtensionSnapshot {
	const state = getSessionExtensionState(session);
	return {
		tools: state.tools.map((tool) => ({ ...tool })),
		commands: state.commands.map((command) => ({ ...command })),
		renderers: [...state.renderers],
		inputHandlers: state.inputHandlers,
		eventHandlers: [...state.eventHandlers],
	};
}

function getSessionMetadata(session: DPiWorkerSession): DPiSessionMetadata {
	const existing = sessionMetadata.get(session);
	if (existing) {
		return existing;
	}
	const metadata = { id: nextSessionId() };
	sessionMetadata.set(session, metadata);
	return metadata;
}

function nextSessionId(): string {
	generatedSessionSequence += 1;
	return `d-pi-session-${generatedSessionSequence}`;
}

function nextGeneratedId(prefix: string): string {
	generatedMessageSequence += 1;
	return `d-pi-${prefix}-${generatedMessageSequence}`;
}

function sanitizeSessionPathPart(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized.slice(0, 48) || "session";
}

function extractImages(input: unknown): Array<{ url: string; mediaType?: string }> | undefined {
	if (!isRecord(input) || !Array.isArray(input.images)) {
		return undefined;
	}
	const images = input.images.flatMap((candidate) => {
		if (!isRecord(candidate) || typeof candidate.url !== "string") {
			return [];
		}
		return [
			{
				url: candidate.url,
				...(typeof candidate.mediaType === "string" ? { mediaType: candidate.mediaType } : {}),
			},
		];
	});
	return images.length > 0 ? images : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
