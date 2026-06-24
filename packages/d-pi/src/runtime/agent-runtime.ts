import { join } from "node:path";
import type {
	AgentHarnessEvent,
	AgentHarnessOptions,
	AgentHarnessPromptOptions,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentMessage,
	AgentTool,
	JsonlSessionMetadata,
	Session,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import {
	AgentHarness,
	AgentHarnessError,
	compact as compactSession,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	NodeExecutionEnv,
	prepareCompaction,
	SessionError,
} from "@earendil-works/pi-agent-core/node";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { DPiContextManager } from "../context/context-manager.ts";
import { createDPiRuntimeError, isDPiRuntimeError } from "./errors.ts";
import type { DPiRuntimeEvent } from "./events.ts";
import type { DPiModelManager } from "./model-manager.ts";
import {
	appendSteeringMessage,
	consumeSteeringMessages,
	readSteeringMessages,
	type SteeringQueueSource,
} from "./steering-jsonl-queue.ts";
import type { DPiTranscriptItem } from "./transcript/projector.ts";
import {
	createDPiTranscriptBoundaryEntry,
	createDPiTranscriptNoticeEntry,
	createDPiTranscriptToolStateEntry,
	createDPiTranscriptTurnStatsEntry,
	DPiTranscriptCustomTypes,
	projectDPiTranscript,
} from "./transcript/projector.ts";
import type {
	DPiAgentMessage,
	DPiJsonValue,
	DPiPromptOptions,
	DPiRuntimeCompactResult,
	DPiRuntimeContextInfo,
	DPiRuntimeError,
	DPiRuntimeErrorCode,
	DPiRuntimeQueues,
	DPiRuntimeSessionInfo,
	DPiRuntimeSnapshot,
	DPiToolQueueItem,
} from "./types.ts";

export type DPiAgentHarnessEvent = AgentHarnessEvent | DPiRuntimeEvent;
export type DPiAgentHarnessEventListener = (event: DPiAgentHarnessEvent) => Promise<void> | void;

export interface DPiAgentHarness {
	prompt(text: string, options?: AgentHarnessPromptOptions): Promise<unknown>;
	steer(text: string, options?: AgentHarnessPromptOptions): Promise<unknown>;
	followUp(text: string, options?: AgentHarnessPromptOptions): Promise<unknown>;
	nextTurn(text: string, options?: AgentHarnessPromptOptions): Promise<unknown>;
	subscribe(listener: DPiAgentHarnessEventListener): () => void;
	setResources?(resources: AgentHarnessResources): Promise<void> | void;
	abort?(): Promise<unknown> | unknown;
}

export interface DPiAgentHarnessFactoryOptions {
	cwd: string;
	session: Session<JsonlSessionMetadata>;
	model: Model<Api>;
	systemPrompt: () => string;
	context: DPiRuntimeContextInfo;
	tools?: AgentTool[];
	resources?: AgentHarnessResources;
	getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	streamOptions?: AgentHarnessStreamOptions;
	activeToolNames?: string[];
	thinkingLevel?: ThinkingLevel;
}

export type DPiAgentHarnessFactory = (options: DPiAgentHarnessFactoryOptions) => DPiAgentHarness;

export interface DPiAgentRuntimeOptions {
	agentName: string;
	cwd: string;
	connectId?: string;
	session: Session<JsonlSessionMetadata>;
	sessionInfo?: DPiRuntimeSessionInfo;
	modelManager: DPiModelManager;
	contextManager: DPiContextManager;
	env?: NodeExecutionEnv;
	tools?: AgentTool[];
	resources?: AgentHarnessResources;
	getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	streamOptions?: AgentHarnessStreamOptions;
	activeToolNames?: string[];
	thinkingLevel?: ThinkingLevel;
	initialMessages?: DPiAgentMessage[];
	steeringQueuePath?: string;
	harnessFactory?: DPiAgentHarnessFactory;
}

type AgentLoopConfigPatch = {
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	[key: string]: unknown;
};

type AgentHarnessWithLoopConfig = DPiAgentHarness & {
	createLoopConfig?: (...args: unknown[]) => AgentLoopConfigPatch;
};

export function installSteeringFileConsumer(harness: DPiAgentHarness, queuePath: string): void {
	const target = harness as AgentHarnessWithLoopConfig;
	if (typeof target.createLoopConfig !== "function") {
		return;
	}
	const originalCreateLoopConfig = target.createLoopConfig.bind(harness);
	target.createLoopConfig = (...args: unknown[]) => {
		const config = originalCreateLoopConfig(...args);
		return {
			...config,
			getSteeringMessages: async () =>
				(await consumeSteeringMessages(queuePath)).map((record): AgentMessage => {
					return {
						role: "user",
						content: [{ type: "text", text: record.text }],
						timestamp: record.createdAt,
					};
				}),
		};
	};
}

function cloneQueues(queues: DPiRuntimeQueues): DPiRuntimeQueues {
	return {
		prompts: queues.prompts.map((item) => ({ ...item, options: item.options ? { ...item.options } : undefined })),
		tools: queues.tools.map((item) => ({ ...item })),
	};
}

function loadContextInfo(contextManager: DPiContextManager): DPiRuntimeContextInfo {
	return {
		systemPromptParts: contextManager.loadSystemPromptParts(),
		contextFiles: contextManager.loadContextFiles(),
		skills: contextManager.loadSkills(),
		extensions: contextManager.loadExtensions(),
	};
}

function toHarnessOptions(options: DPiPromptOptions): AgentHarnessPromptOptions | undefined {
	const images = options.images
		?.filter((image) => image.data !== undefined)
		.map(
			(image): ImageContent => ({
				type: "image",
				data: image.data ?? "",
				mimeType: image.mediaType,
			}),
		);
	return images && images.length > 0 ? { images } : undefined;
}

function promptImagesFromHarnessOptions(options: AgentHarnessPromptOptions | undefined): DPiPromptOptions["images"] {
	return options?.images?.map((image) => ({ mediaType: image.mimeType, data: image.data }));
}

function errorCodeFromHarness(error: AgentHarnessError): DPiRuntimeErrorCode {
	if (error.code === "busy") {
		return "busy";
	}
	if (error.code === "auth") {
		return "auth";
	}
	if (error.code === "session") {
		return "invalid_session";
	}
	return "unknown";
}

function isBusyHarnessError(error: unknown): boolean {
	return (
		(error instanceof AgentHarnessError && error.code === "busy") ||
		(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "busy")
	);
}

function errorCodeFromMessage(message: string): DPiRuntimeErrorCode {
	const lower = message.toLowerCase();
	if (lower.includes("auth") || lower.includes("api key") || lower.includes("unauthorized")) {
		return "auth";
	}
	if (lower.includes("session")) {
		return "invalid_session";
	}
	if (lower.includes("model")) {
		return "missing_model";
	}
	if (lower.includes("network") || lower.includes("fetch") || lower.includes("timeout")) {
		return "network";
	}
	if (lower.includes("executor")) {
		return "executor_unavailable";
	}
	return "unknown";
}

function toDPiRuntimeError(error: unknown): DPiRuntimeError {
	if (isDPiRuntimeError(error)) {
		return error;
	}
	if (error instanceof AgentHarnessError) {
		const code = errorCodeFromHarness(error);
		return createDPiRuntimeError(code, error.message, {
			retryable: code === "busy" || code === "network",
			details: { harnessErrorCode: error.code },
		});
	}
	if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "busy") {
		return createDPiRuntimeError("busy", error.message, {
			retryable: true,
			details: { harnessErrorCode: "busy" },
		});
	}
	if (error instanceof SessionError) {
		return createDPiRuntimeError("invalid_session", error.message, {
			details: { sessionErrorCode: error.code },
		});
	}
	if (error instanceof Error) {
		const code = errorCodeFromMessage(error.message);
		return createDPiRuntimeError(code, error.message, {
			retryable: code === "network",
		});
	}
	return createDPiRuntimeError("unknown", String(error));
}

function isJsonValue(value: unknown, visited: WeakSet<object> = new WeakSet<object>()): value is DPiJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value !== "object") {
		return false;
	}
	if (visited.has(value)) {
		return false;
	}
	visited.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, visited))
		: Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, visited));
	visited.delete(value);
	return valid;
}

function jsonValueOrUndefined(value: unknown): DPiJsonValue | undefined {
	return isJsonValue(value) ? value : undefined;
}

function textFromMessage(message: DPiAgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
			.join("");
	}
	return "";
}

function queueItems(messages: DPiAgentMessage[], mode: "steer" | "followUp" | "next"): DPiRuntimeQueues["prompts"] {
	return messages.map((message, index) => ({
		id: `${mode}-${index}`,
		text: textFromMessage(message),
		mode: mode === "next" ? "next" : mode,
		source: "runtime",
		createdAt: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
	}));
}

function toolQueueItem(event: {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
}): DPiToolQueueItem {
	return {
		id: event.toolCallId,
		name: event.toolName,
		status: event.isError ? "failed" : "running",
		createdAt: Date.now(),
		args: jsonValueOrUndefined(event.args),
		result: jsonValueOrUndefined(event.result),
	};
}

function toolNameFromResult(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("toolName" in result)) {
		return undefined;
	}
	const toolName = (result as { toolName?: unknown }).toolName;
	return typeof toolName === "string" ? toolName : undefined;
}

export class DPiAgentRuntime {
	private readonly agentName: string;
	private readonly connectId: string | undefined;
	private readonly cwd: string;
	private readonly contextManager: DPiContextManager;
	private readonly modelManager: DPiModelManager;
	private readonly session: Session<JsonlSessionMetadata>;
	private readonly getApiKeyAndHeaders: AgentHarnessOptions["getApiKeyAndHeaders"] | undefined;
	private readonly thinkingLevel: ThinkingLevel | undefined;
	private readonly steeringQueuePath: string;
	private readonly harness: DPiAgentHarness;
	private readonly listeners = new Set<(event: DPiRuntimeEvent) => Promise<void> | void>();
	private readonly unsubscribeHarness: () => void;
	private context: DPiRuntimeContextInfo;
	private queues: DPiRuntimeQueues = { prompts: [], tools: [] };
	private messages: DPiAgentMessage[] = [];
	private transcriptItems: DPiTranscriptItem[] = [];
	private readonly sessionInfo: DPiRuntimeSessionInfo;
	private activeTurn = false;
	private turnStartedAt: number | undefined;

	constructor(options: DPiAgentRuntimeOptions) {
		this.agentName = options.agentName;
		this.connectId = options.connectId;
		this.cwd = options.cwd;
		this.contextManager = options.contextManager;
		this.modelManager = options.modelManager;
		this.session = options.session;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
		this.thinkingLevel = options.thinkingLevel;
		this.steeringQueuePath = options.steeringQueuePath ?? join(this.contextManager.getAgentDir(), "steering.jsonl");
		this.context = loadContextInfo(this.contextManager);
		this.sessionInfo = options.sessionInfo ?? { id: "unknown" };
		this.messages = options.initialMessages?.map((message) => ({ ...message })) ?? [];
		this.transcriptItems = this.messages.map((message, index) => ({
			id: `initial-message-${index}`,
			type: "message",
			message,
			timestamp: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		}));
		const env = options.env ?? new NodeExecutionEnv({ cwd: this.cwd });
		const factory =
			options.harnessFactory ??
			((factoryOptions: DPiAgentHarnessFactoryOptions): DPiAgentHarness =>
				new AgentHarness({
					env,
					session: factoryOptions.session,
					model: factoryOptions.model,
					systemPrompt: factoryOptions.systemPrompt,
					tools: factoryOptions.tools,
					resources: factoryOptions.resources,
					getApiKeyAndHeaders: factoryOptions.getApiKeyAndHeaders,
					streamOptions: factoryOptions.streamOptions,
					activeToolNames: factoryOptions.activeToolNames,
					thinkingLevel: factoryOptions.thinkingLevel,
				}));
		this.harness = factory({
			cwd: this.cwd,
			session: options.session,
			model: this.modelManager.getModel(),
			systemPrompt: () => this.systemPrompt(),
			context: this.cloneContext(),
			tools: options.tools,
			resources: options.resources,
			getApiKeyAndHeaders: options.getApiKeyAndHeaders,
			streamOptions: options.streamOptions,
			activeToolNames: options.activeToolNames,
			thinkingLevel: options.thinkingLevel,
		});
		installSteeringFileConsumer(this.harness, this.steeringQueuePath);
		this.unsubscribeHarness = this.harness.subscribe((event) => this.handleHarnessEvent(event));
	}

	subscribe(listener: (event: DPiRuntimeEvent) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string, options: DPiPromptOptions = {}): Promise<void> {
		try {
			const mode = options.mode ?? "next";
			const harnessOptions = toHarnessOptions(options);
			if (mode === "steer" || mode === "followUp") {
				await this.enqueueSteeringMessage(text, options, "runtime");
			} else {
				await this.promptNextTurn(text, harnessOptions);
			}
		} catch (error) {
			const runtimeError = toDPiRuntimeError(error);
			await this.emit({ type: "error", agentName: this.agentName, error: runtimeError });
			throw runtimeError;
		}
	}

	async abort(): Promise<void> {
		await this.harness.abort?.();
		this.activeTurn = false;
		await this.emit({ type: "agent_end", agentName: this.agentName });
	}

	async reloadContext(): Promise<void> {
		this.contextManager.reload();
		this.context = loadContextInfo(this.contextManager);
		await this.harness.setResources?.({ skills: [], promptTemplates: [] });
		await this.emit({
			type: "state_update",
			agentName: this.agentName,
			state: { context: this.cloneContext() },
		});
		await this.emit({ type: "snapshot_update", snapshot: this.getSnapshot() });
	}

	async compact(customInstructions?: string): Promise<DPiRuntimeCompactResult> {
		const startedAt = Date.now();
		const model = this.modelManager.getModel();
		const auth = await this.getApiKeyAndHeaders?.(model);
		if (!auth?.apiKey) {
			throw createDPiRuntimeError("auth", `No API key found for ${model.provider}.`);
		}

		const branch = await this.session.getBranch();
		const preparation = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS);
		if (!preparation.ok) {
			throw preparation.error;
		}
		if (!preparation.value) {
			const lastEntry = branch[branch.length - 1];
			throw new Error(
				lastEntry?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)",
			);
		}

		const result = await compactSession(
			preparation.value,
			model,
			auth.apiKey,
			auth.headers,
			customInstructions,
			undefined,
			this.thinkingLevel,
		);
		if (!result.ok) {
			throw result.error;
		}

		await this.session.appendCompaction(
			result.value.summary,
			result.value.firstKeptEntryId,
			result.value.tokensBefore,
			result.value.details,
		);
		const completedAt = Date.now();
		const durationMs = completedAt - startedAt;
		const label = `Compact completed ${Math.max(1, Math.ceil(durationMs / 1000))}s`;
		await this.session.appendCustomEntry(
			DPiTranscriptCustomTypes.boundary,
			createDPiTranscriptBoundaryEntry({
				reason: "compact",
				label,
				summary: result.value.summary,
				tokensBefore: result.value.tokensBefore,
				durationMs,
				completedAt,
			}),
		);
		const transcript = projectDPiTranscript(await this.session.getBranch());
		const currentPageMessages = transcript.messages;
		this.transcriptItems = transcript.items;
		this.messages =
			currentPageMessages.length > 0
				? currentPageMessages
				: ((await this.session.buildContext()).messages as DPiAgentMessage[]);
		await this.emit({ type: "snapshot_update", snapshot: this.getSnapshot() });
		return {
			...result.value,
			divider: {
				label,
				details: {
					summary: result.value.summary,
					tokensBefore: result.value.tokensBefore,
					durationMs,
					completedAt,
				},
			},
			transcriptItems: this.transcriptItems.map((item) => ({ ...item })),
			messages: this.messages.map((message) => ({ ...message })),
		};
	}

	getSnapshot(): DPiRuntimeSnapshot {
		const model = this.modelManager.getModelInfo();
		const contextWindow = model.contextWindow ?? 0;
		const contextEstimate = estimateContextTokens(this.messages);
		const tokens = contextEstimate.tokens;
		const percent = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
		return {
			agentName: this.agentName,
			...(this.connectId ? { connectId: this.connectId } : {}),
			cwd: this.cwd,
			context: this.cloneContext(),
			messages: this.messages.map((message) => ({ ...message })),
			transcriptItems: this.transcriptItems.map((item) => ({ ...item })),
			streaming: { active: this.activeTurn },
			compaction: { status: "idle", queued: false },
			bash: { active: false, cwd: this.cwd, commands: [] },
			queues: cloneQueues(this.queues),
			model,
			thinking: {},
			contextUsage: { tokens, contextWindow, percent },
			tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			session: { ...this.sessionInfo },
			commands: [],
			settings: {},
		};
	}

	dispose(): void {
		this.unsubscribeHarness();
		this.listeners.clear();
	}

	private systemPrompt(): string {
		return this.context.systemPromptParts.join("\n\n");
	}

	private cloneContext(): DPiRuntimeContextInfo {
		return {
			systemPromptParts: [...this.context.systemPromptParts],
			contextFiles: this.context.contextFiles.map((file) => ({ ...file })),
			skills: [...this.context.skills],
			extensions: [...this.context.extensions],
		};
	}

	private async promptNextTurn(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
		if (this.activeTurn) {
			await this.enqueueSteeringMessage(
				text,
				{ mode: "steer", images: promptImagesFromHarnessOptions(options) },
				"runtime",
			);
			return;
		}
		this.activeTurn = true;
		this.turnStartedAt = Date.now();
		try {
			await this.harness.prompt(text, options);
		} catch (error) {
			if (isBusyHarnessError(error)) {
				await this.enqueueSteeringMessage(
					text,
					{ mode: "steer", images: promptImagesFromHarnessOptions(options) },
					"runtime",
				);
				return;
			}
			throw error;
		} finally {
			this.activeTurn = false;
		}
	}

	private async handleHarnessEvent(event: DPiAgentHarnessEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.turnStartedAt = Date.now();
			await this.emit({ type: "agent_start", agentName: this.agentName });
			return;
		}
		if (event.type === "agent_end") {
			await this.emit({ type: "agent_end", agentName: this.agentName });
			if ("messages" in event) {
				await this.emitTurnStats(event.messages as DPiAgentMessage[]);
			}
			return;
		}
		const runtimeEvent = this.normalizeHarnessEvent(event);
		if (!runtimeEvent) {
			return;
		}
		if (runtimeEvent.type === "queue_update") {
			this.queues = cloneQueues(runtimeEvent.queues);
		} else if (runtimeEvent.type === "message") {
			this.messages = [...this.messages, runtimeEvent.message];
			this.upsertTranscriptItem({
				id: `message-${this.transcriptItems.length}`,
				type: "message",
				message: runtimeEvent.message,
				timestamp:
					"timestamp" in runtimeEvent.message && typeof runtimeEvent.message.timestamp === "number"
						? runtimeEvent.message.timestamp
						: Date.now(),
			});
		} else if (runtimeEvent.type === "assistant_stream" && runtimeEvent.message && runtimeEvent.done) {
			this.messages = [...this.messages, runtimeEvent.message];
			this.upsertTranscriptItem({
				id: `message-${this.transcriptItems.length}`,
				type: "message",
				message: runtimeEvent.message,
				timestamp:
					"timestamp" in runtimeEvent.message && typeof runtimeEvent.message.timestamp === "number"
						? runtimeEvent.message.timestamp
						: Date.now(),
			});
		} else if (runtimeEvent.type === "error") {
			await this.appendTranscriptNotice("error", runtimeEvent.error.message);
			await this.emit(runtimeEvent);
			return;
		}
		await this.appendTranscriptEvent(runtimeEvent);
		await this.emit(runtimeEvent);
	}

	private async emitTurnStats(messages: DPiAgentMessage[]): Promise<void> {
		if (this.turnStartedAt === undefined) {
			return;
		}
		const duration = (Date.now() - this.turnStartedAt) / 1000;
		this.turnStartedAt = undefined;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		for (const message of messages) {
			if (message.role !== "assistant") {
				continue;
			}
			input += message.usage.input;
			output += message.usage.output;
			cacheRead += message.usage.cacheRead;
			cacheWrite += message.usage.cacheWrite;
		}
		const total = input + output + cacheRead + cacheWrite;
		if (total === 0) {
			return;
		}
		const stats = {
			type: "turn_stats",
			agentName: this.agentName,
			tps: duration > 0 ? output / duration : 0,
			output,
			input,
			cacheRead,
			cacheWrite,
			total,
			duration,
		} as const;
		await this.session.appendCustomEntry(
			DPiTranscriptCustomTypes.turnStats,
			createDPiTranscriptTurnStatsEntry({
				tps: stats.tps,
				output,
				input,
				cacheRead,
				cacheWrite,
				total,
				duration,
				timestamp: Date.now(),
			}),
		);
		this.upsertTranscriptItem({
			id: `turn-stats-${this.transcriptItems.length}`,
			type: "turn_stats",
			tps: stats.tps,
			output,
			input,
			cacheRead,
			cacheWrite,
			total,
			duration,
			timestamp: Date.now(),
		});
		await this.emit(stats);
	}

	private async appendTranscriptEvent(event: DPiRuntimeEvent): Promise<void> {
		if (event.type === "tool_start") {
			const item: DPiTranscriptItem = {
				id: `tool-state-${event.tool.id}`,
				type: "tool_state",
				toolCallId: event.tool.id,
				toolName: event.tool.name,
				status: "running",
				...(event.tool.args === undefined ? {} : { args: event.tool.args }),
				timestamp: event.tool.startedAt,
			};
			await this.session.appendCustomEntry(
				DPiTranscriptCustomTypes.toolState,
				createDPiTranscriptToolStateEntry({
					toolCallId: item.toolCallId,
					toolName: item.toolName,
					status: item.status,
					...(item.args === undefined ? {} : { args: item.args }),
					timestamp: item.timestamp,
				}),
			);
			this.upsertTranscriptItem(item);
			return;
		}
		if (event.type === "tool_end") {
			const existing = this.transcriptItems.find(
				(item) => item.type === "tool_state" && item.toolCallId === event.toolCallId,
			);
			const item: DPiTranscriptItem = {
				id: `tool-state-${event.toolCallId}`,
				type: "tool_state",
				toolCallId: event.toolCallId,
				toolName: event.toolName ?? toolNameFromResult(event.result) ?? event.toolCallId,
				status: event.status,
				...(existing?.type === "tool_state" && existing.args !== undefined ? { args: existing.args } : {}),
				...(event.result === undefined ? {} : { result: event.result }),
				...(event.error === undefined ? {} : { error: event.error }),
				timestamp: event.endedAt,
			};
			await this.session.appendCustomEntry(
				DPiTranscriptCustomTypes.toolState,
				createDPiTranscriptToolStateEntry({
					toolCallId: item.toolCallId,
					toolName: item.toolName,
					status: item.status,
					...(item.args === undefined ? {} : { args: item.args }),
					...(item.result === undefined ? {} : { result: item.result }),
					...(item.error === undefined ? {} : { error: item.error }),
					timestamp: item.timestamp,
				}),
			);
			this.upsertTranscriptItem(item);
		}
	}

	private async enqueueSteeringMessage(
		text: string,
		options: DPiPromptOptions,
		source: SteeringQueueSource,
	): Promise<void> {
		await appendSteeringMessage(this.steeringQueuePath, {
			text,
			source,
			...(options.images
				? {
						images: options.images.flatMap((image) =>
							image.url ? [{ url: image.url, mediaType: image.mediaType }] : [],
						),
					}
				: {}),
		});
		await this.emit({
			type: "queue_update",
			agentName: this.agentName,
			queues: {
				prompts: (await readSteeringMessages(this.steeringQueuePath)).map((record) => ({
					id: record.id,
					text: record.text,
					mode: "steer",
					source: record.source,
					createdAt: record.createdAt,
				})),
				tools: [],
			},
		});
	}

	private async appendTranscriptNotice(level: "error" | "info" | "warning", text: string): Promise<void> {
		const item: DPiTranscriptItem = {
			id: `notice-${this.transcriptItems.length}`,
			type: "notice",
			level,
			text,
			timestamp: Date.now(),
		};
		await this.session.appendCustomEntry(
			DPiTranscriptCustomTypes.notice,
			createDPiTranscriptNoticeEntry({
				level: item.level,
				text: item.text,
				timestamp: item.timestamp,
			}),
		);
		this.upsertTranscriptItem(item);
	}

	private upsertTranscriptItem(item: DPiTranscriptItem): void {
		const index = this.transcriptItems.findIndex((candidate) => candidate.id === item.id);
		if (index < 0) {
			this.transcriptItems.push(item);
			return;
		}
		this.transcriptItems[index] = item;
	}

	private normalizeHarnessEvent(event: DPiAgentHarnessEvent): DPiRuntimeEvent | undefined {
		if (event.type === "error") {
			return { ...event, agentName: event.agentName ?? this.agentName };
		}
		if ("agentName" in event || event.type === "snapshot_update") {
			return event as DPiRuntimeEvent;
		}
		if (event.type === "queue_update") {
			return {
				type: "queue_update",
				agentName: this.agentName,
				queues: {
					prompts: queueItems(event.steer as DPiAgentMessage[], "steer"),
					tools: [],
				},
			};
		}
		if (event.type === "message_update") {
			return {
				type: "assistant_stream",
				agentName: this.agentName,
				message: event.message as DPiAgentMessage,
				done: false,
			};
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			return {
				type: "assistant_stream",
				agentName: this.agentName,
				message: event.message as DPiAgentMessage,
				done: true,
			};
		}
		if (event.type === "message_end" && event.message.role === "user") {
			return {
				type: "message",
				agentName: this.agentName,
				message: event.message as DPiAgentMessage,
			};
		}
		if (event.type === "tool_execution_start") {
			return {
				type: "tool_start",
				agentName: this.agentName,
				tool: {
					id: event.toolCallId,
					name: event.toolName,
					args: jsonValueOrUndefined(event.args),
					startedAt: Date.now(),
				},
			};
		}
		if (event.type === "tool_execution_update") {
			return {
				type: "tool_update",
				agentName: this.agentName,
				toolCallId: event.toolCallId,
				status: "running",
				details: jsonValueOrUndefined(event.partialResult),
			};
		}
		if (event.type === "tool_execution_end") {
			const tool = toolQueueItem(event);
			return {
				type: "tool_end",
				agentName: this.agentName,
				toolCallId: tool.id,
				toolName: event.toolName,
				status: event.isError ? "failed" : "succeeded",
				result: tool.result,
				endedAt: Date.now(),
			};
		}
		return undefined;
	}

	private async emit(event: DPiRuntimeEvent): Promise<void> {
		for (const listener of this.listeners) {
			await listener(event);
		}
	}
}
