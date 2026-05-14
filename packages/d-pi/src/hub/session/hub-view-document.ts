import * as Automerge from "@automerge/automerge";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RegisteredPeer } from "../peers/peer-types.js";
import type { LiveRenderEvent } from "../transport/live-events.js";
import type { HubSessionEvent } from "./session-events.js";
import {
	HUB_RUN_TIMING_CUSTOM_TYPE,
	type HubQueuedInputMessage,
	type HubRunEndReason,
	type HubRunTiming,
	type HubSessionSnapshot,
} from "./session-snapshot.js";

const MAX_AGENT_VIEW_ITEMS = 500;

export interface HubViewDocumentState extends Record<string, unknown> {
	version: 1;
	agentOrder: string[];
	agentsById: Record<string, HubAgentViewModel>;
	peers: RegisteredPeer[];
}

export interface HubAgentViewModel extends Record<string, unknown> {
	agentId: string;
	parentId?: string;
	kind?: "root" | "child" | "guest";
	lifecycle?: "persistent" | "temporary";
	name?: string;
	description?: string;
	summary?: string;
	sessionId?: string;
	cwd?: string;
	sessionFile?: string;
	protocolVersion?: number;
	status: HubAgentStatusViewModel;
	queue: HubAgentQueueViewModel;
	context: HubAgentContextViewModel;
	items: HubAgentViewItem[];
	live: HubAgentLiveViewModel;
	availableModels: HubSessionSnapshot["availableModels"];
	availableThinkingLevels: string[];
	diagnostics: string[];
	lastError?: string;
}

export type HubAgentViewItem =
	| {
			type: "message";
			message: AgentMessage;
	  }
	| {
			type: "run_timing";
			timing: HubRunTiming;
	  };

export interface HubAgentStatusViewModel extends Record<string, unknown> {
	isRunning: boolean;
	runStartedAt?: string;
	lastRunStartedAt?: string;
	lastRunEndedAt?: string;
	lastRunDurationMs?: number;
	lastRunEndReason?: HubRunEndReason;
}

export interface HubAgentQueueViewModel extends Record<string, unknown> {
	messages: HubQueuedInputMessage[];
	size: number;
}

export interface HubAgentContextViewModel extends Record<string, unknown> {
	model: HubSessionSnapshot["context"]["model"];
	thinkingLevel: string;
	contextUsage?: HubSessionSnapshot["contextUsage"];
	pendingToolCallIds: string[];
}

export interface HubAgentLiveViewModel extends Record<string, unknown> {
	streamingMessageId?: string;
	streamingMessageIndex?: number;
	itemIndicesById: Record<string, number>;
	toolOrder: string[];
	toolsById: Record<string, HubLiveToolExecutionViewModel>;
	statusMessage?: string;
}

export interface HubLiveToolExecutionViewModel extends Record<string, unknown> {
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	partialResult?: AgentToolResult<unknown>;
	result?: AgentToolResult<unknown>;
	isError?: boolean;
}

export interface HubViewSyncMessage {
	syncState: HubViewProjectionState;
	message: Uint8Array | null;
	format: "snapshot" | "incremental";
}

export interface HubViewProjectionState {
	heads: string[] | undefined;
}

export class HubViewDocument {
	private doc: Automerge.Doc<HubViewDocumentState>;
	/**
	 * Mutations applied since the last {@link compactHistory} or {@link resetSession}. Used as a cheap
	 * proxy for "history size" so callers can decide when to compact without paying the O(n) cost of
	 * Automerge.getAllChanges on every hot-path mutation.
	 */
	private mutationsSinceCompact = 0;

	constructor(initialState: HubViewDocumentState = createEmptyViewDocumentState()) {
		this.doc = Automerge.from(deepCloneJson(initialState));
	}

	getChangeCount(): number {
		return this.mutationsSinceCompact;
	}

	compactHistory(): void {
		this.doc = Automerge.from(deepCloneJson(Automerge.toJS(this.doc) as HubViewDocumentState));
		this.mutationsSinceCompact = 0;
	}

	createSyncState(): HubViewProjectionState {
		return { heads: undefined };
	}

	resetSession(snapshot: HubSessionSnapshot, agentId = snapshot.header.id): void {
		this.doc = Automerge.from(createViewDocumentStateFromSession(snapshot, agentId, this.doc.peers ?? []));
		this.mutationsSinceCompact = 0;
	}

	syncAgentList(agentIds: readonly string[]): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			const uniqueAgentIds = Array.from(new Set(agentIds));
			for (const agentId of uniqueAgentIds) {
				ensureAgent(doc, agentId);
			}
			syncArray(doc.agentOrder, uniqueAgentIds);
			for (const agentId of Object.keys(doc.agentsById)) {
				if (!uniqueAgentIds.includes(agentId)) {
					delete doc.agentsById[agentId];
				}
			}
		});
		this.mutationsSinceCompact += 1;
	}

	updateAgentMetadata(
		agentId: string,
		metadata: Pick<HubAgentViewModel, "parentId" | "kind" | "lifecycle" | "name" | "description">,
	): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			const agent = ensureAgent(doc, agentId);
			syncOptionalProperty(agent, "parentId", metadata.parentId);
			syncOptionalProperty(agent, "kind", metadata.kind);
			syncOptionalProperty(agent, "lifecycle", metadata.lifecycle);
			syncOptionalProperty(agent, "name", metadata.name);
			syncOptionalProperty(agent, "description", metadata.description);
		});
		this.mutationsSinceCompact += 1;
	}

	updateAgentSummary(agentId: string, summary: string | undefined): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			const agent = ensureAgent(doc, agentId);
			syncOptionalProperty(agent, "summary", summary);
		});
		this.mutationsSinceCompact += 1;
	}

	updateSession(snapshot: HubSessionSnapshot, agentId = snapshot.header.id): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			const agent = ensureAgent(doc, agentId);
			if (agent.sessionId === undefined || agent.sessionId !== snapshot.header.id) {
				syncArray(agent.items, createItemsFromEntries(snapshot.entries));
				agent.live = createEmptyLiveState();
			}
			agent.sessionId = snapshot.header.id;
			agent.cwd = snapshot.header.cwd;
			agent.protocolVersion = snapshot.header.version;
			agent.sessionFile = snapshot.sessionFile;
			syncOptionalProperty(agent, "summary", snapshot.summary);
			agent.status.isRunning = snapshot.isRunning;
			syncOptionalProperty(agent.status, "runStartedAt", snapshot.runStartedAt);
			syncOptionalProperty(agent.status, "lastRunStartedAt", snapshot.lastRunStartedAt);
			syncOptionalProperty(agent.status, "lastRunEndedAt", snapshot.lastRunEndedAt);
			syncOptionalProperty(agent.status, "lastRunDurationMs", snapshot.lastRunDurationMs);
			syncOptionalProperty(agent.status, "lastRunEndReason", snapshot.lastRunEndReason);
			syncProperty(agent.queue, "messages", snapshot.queuedMessages ?? []);
			agent.queue.size = snapshot.queuedMessages?.length ?? 0;
			syncProperty(agent, "availableModels", snapshot.availableModels);
			syncProperty(agent, "availableThinkingLevels", snapshot.availableThinkingLevels);
			syncProperty(agent, "diagnostics", snapshot.diagnostics);
			syncOptionalProperty(agent, "lastError", snapshot.lastError);
			syncProperty(agent.context, "model", snapshot.context.model);
			agent.context.thinkingLevel = snapshot.context.thinkingLevel;
			syncOptionalProperty(agent.context, "contextUsage", snapshot.contextUsage);
			syncProperty(agent.context, "pendingToolCallIds", snapshot.pendingToolCallIds);
		});
		this.mutationsSinceCompact += 1;
	}

	updateLiveEvent(event: LiveRenderEvent, agentId?: string): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			const agent = ensureAgent(doc, agentId ?? getDefaultAgentId(doc));
			applyLiveEventToAgent(doc, agent.agentId, agent, event);
		});
		this.mutationsSinceCompact += 1;
	}

	updateSessionEvent(event: HubSessionEvent, agentId?: string): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			const agent = ensureAgent(doc, agentId ?? getDefaultAgentId(doc));
			applySessionEventToAgent(agent, event);
		});
		this.mutationsSinceCompact += 1;
	}

	updatePeers(peers: RegisteredPeer[]): void {
		this.doc = Automerge.change(this.doc, (doc) => {
			syncProperty(doc as unknown as Record<string, unknown>, "peers", toJsonCompatible(peers.map(createPeerView)));
		});
		this.mutationsSinceCompact += 1;
	}

	generateSyncMessage(syncState: HubViewProjectionState): HubViewSyncMessage {
		const heads = sortHeads(Automerge.getHeads(this.doc));
		if (syncState.heads && sameHeads(syncState.heads, heads)) {
			return { syncState, message: null, format: "incremental" };
		}
		if (!syncState.heads || !Automerge.hasHeads(this.doc, syncState.heads)) {
			return { syncState: { heads }, message: Automerge.save(this.doc), format: "snapshot" };
		}
		const message = Automerge.saveSince(this.doc, syncState.heads);
		return {
			syncState: { heads },
			message: message.byteLength > 0 ? message : null,
			format: "incremental",
		};
	}

	receiveSyncMessage(syncState: HubViewProjectionState, message: Uint8Array): HubViewProjectionState {
		this.validateReadOnlySyncMessage(message);
		return syncState;
	}

	validateReadOnlySyncMessage(message: Uint8Array): void {
		const decoded = Automerge.decodeSyncMessage(message);
		if (decoded.changes.length > 0) {
			throw new Error("Hub view document sync is read-only for peers.");
		}
	}

	getSnapshot(): Automerge.Doc<HubViewDocumentState> {
		return this.doc;
	}
}

export function createEmptyViewDocumentState(): HubViewDocumentState {
	return {
		version: 1,
		agentOrder: [],
		agentsById: {},
		peers: [],
	};
}

function sortHeads(heads: string[]): string[] {
	return [...heads].sort();
}

function sameHeads(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((head, index) => head === b[index]);
}

function createViewDocumentStateFromSession(
	snapshot: HubSessionSnapshot,
	agentId: string,
	peers: RegisteredPeer[],
): HubViewDocumentState {
	return {
		version: 1,
		agentOrder: [agentId],
		agentsById: {
			[agentId]: createAgentFromSnapshot(agentId, snapshot),
		},
		peers: deepCloneJson(peers.map(createPeerView)),
	};
}

function createPeerView(peer: RegisteredPeer): RegisteredPeer {
	return {
		...peer,
		...(peer.mcpSnapshot
			? {
					mcpSnapshot: {
						...peer.mcpSnapshot,
						servers: peer.mcpSnapshot.servers.map((server) => ({
							...server,
							capabilities: {
								tools: server.capabilities.tools.map(({ name, description }) => ({ name, description })),
								resources: server.capabilities.resources.map((resource) => ({ ...resource })),
								prompts: server.capabilities.prompts.map((prompt) => ({ ...prompt })),
							},
						})),
					},
				}
			: {}),
	};
}

function createAgentFromSnapshot(agentId: string, snapshot: HubSessionSnapshot): HubAgentViewModel {
	return {
		agentId,
		sessionId: snapshot.header.id,
		cwd: snapshot.header.cwd,
		protocolVersion: snapshot.header.version,
		sessionFile: snapshot.sessionFile,
		...(snapshot.summary === undefined ? {} : { summary: snapshot.summary }),
		status: {
			isRunning: snapshot.isRunning,
			...(snapshot.runStartedAt === undefined ? {} : { runStartedAt: snapshot.runStartedAt }),
			...(snapshot.lastRunStartedAt === undefined ? {} : { lastRunStartedAt: snapshot.lastRunStartedAt }),
			...(snapshot.lastRunEndedAt === undefined ? {} : { lastRunEndedAt: snapshot.lastRunEndedAt }),
			...(snapshot.lastRunDurationMs === undefined ? {} : { lastRunDurationMs: snapshot.lastRunDurationMs }),
			...(snapshot.lastRunEndReason === undefined ? {} : { lastRunEndReason: snapshot.lastRunEndReason }),
		},
		queue: {
			messages: deepCloneJson(snapshot.queuedMessages ?? []),
			size: snapshot.queuedMessages?.length ?? 0,
		},
		context: {
			model: deepCloneJson(snapshot.context.model),
			thinkingLevel: snapshot.context.thinkingLevel,
			pendingToolCallIds: deepCloneJson(snapshot.pendingToolCallIds),
			...(snapshot.contextUsage === undefined ? {} : { contextUsage: deepCloneJson(snapshot.contextUsage) }),
		},
		items: createItemsFromEntries(snapshot.entries),
		live: createEmptyLiveState(),
		availableModels: deepCloneJson(snapshot.availableModels),
		availableThinkingLevels: deepCloneJson(snapshot.availableThinkingLevels),
		diagnostics: deepCloneJson(snapshot.diagnostics),
		...(snapshot.lastError === undefined ? {} : { lastError: snapshot.lastError }),
	};
}

function deepCloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function toJsonCompatible(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value)) as unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value) as object | null;
	return proto === Object.prototype || proto === null;
}

function syncProperty(target: Record<string, unknown>, key: string, sourceValue: unknown): void {
	const currentValue = target[key];
	if (Array.isArray(sourceValue)) {
		if (Array.isArray(currentValue)) {
			syncArray(currentValue, sourceValue);
			return;
		}
		target[key] = deepCloneJson(sourceValue);
		return;
	}
	if (isPlainRecord(sourceValue)) {
		if (isPlainRecord(currentValue)) {
			syncRecord(currentValue, sourceValue);
			return;
		}
		target[key] = deepCloneJson(sourceValue);
		return;
	}
	if (!Object.is(currentValue, sourceValue)) {
		target[key] = sourceValue;
	}
}

function syncRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(target)) {
		if (!(key in source)) {
			delete target[key];
		}
	}
	for (const [key, value] of Object.entries(source)) {
		syncProperty(target, key, value);
	}
}

function syncArray(target: unknown[], source: unknown[]): void {
	while (target.length > source.length) {
		target.pop();
	}
	for (let i = 0; i < source.length; i += 1) {
		const sourceValue = source[i];
		if (i >= target.length) {
			target.push(deepCloneJson(sourceValue));
			continue;
		}
		syncArrayIndex(target, i, sourceValue);
	}
}

function syncArrayIndex(target: unknown[], index: number, sourceValue: unknown): void {
	const currentValue = target[index];
	if (Array.isArray(sourceValue)) {
		if (Array.isArray(currentValue)) {
			syncArray(currentValue, sourceValue);
			return;
		}
		target[index] = deepCloneJson(sourceValue);
		return;
	}
	if (isPlainRecord(sourceValue)) {
		if (isPlainRecord(currentValue)) {
			syncRecord(currentValue, sourceValue);
			return;
		}
		target[index] = deepCloneJson(sourceValue);
		return;
	}
	if (!Object.is(currentValue, sourceValue)) {
		target[index] = sourceValue;
	}
}

function ensureAgent(doc: HubViewDocumentState, agentId: string): HubAgentViewModel {
	const existing = doc.agentsById[agentId];
	if (existing) {
		return existing;
	}
	const agent = createEmptyAgent(agentId);
	doc.agentsById[agentId] = agent;
	doc.agentOrder.push(agentId);
	return doc.agentsById[agentId];
}

function createEmptyAgent(agentId: string): HubAgentViewModel {
	return {
		agentId,
		status: {
			isRunning: false,
		},
		queue: {
			messages: [],
			size: 0,
		},
		context: {
			model: null,
			thinkingLevel: "off",
			pendingToolCallIds: [],
		},
		items: [],
		live: createEmptyLiveState(),
		availableModels: [],
		availableThinkingLevels: [],
		diagnostics: [],
	};
}

function createItemsFromEntries(entries: SessionEntry[]): HubAgentViewItem[] {
	return entries
		.flatMap((entry): HubAgentViewItem[] => {
			if (entry.type === "message") {
				return [{ type: "message", message: deepCloneJson(entry.message) }];
			}
			if (entry.type === "custom" && entry.customType === HUB_RUN_TIMING_CUSTOM_TYPE) {
				const timing = parseHubRunTiming(entry.data);
				return timing ? [{ type: "run_timing", timing }] : [];
			}
			return [];
		})
		.slice(-MAX_AGENT_VIEW_ITEMS);
}

function parseHubRunTiming(value: unknown): HubRunTiming | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Partial<HubRunTiming>;
	if (
		!validIsoString(candidate.startedAt) ||
		!validIsoString(candidate.endedAt) ||
		typeof candidate.durationMs !== "number" ||
		!Number.isFinite(candidate.durationMs) ||
		!isHubRunEndReason(candidate.endReason)
	) {
		return undefined;
	}
	return {
		startedAt: candidate.startedAt,
		endedAt: candidate.endedAt,
		durationMs: candidate.durationMs,
		endReason: candidate.endReason,
	};
}

function validIsoString(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isHubRunEndReason(value: unknown): value is HubRunEndReason {
	return value === "completed" || value === "interrupted" || value === "error";
}

function createEmptyLiveState(): HubAgentLiveViewModel {
	return {
		itemIndicesById: {},
		toolOrder: [],
		toolsById: {},
	};
}

function syncOptionalProperty(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined) {
		delete target[key];
		return;
	}
	syncProperty(target, key, value);
}

function getDefaultAgentId(doc: HubViewDocumentState): string {
	return doc.agentOrder[0] ?? "root";
}

function applyLiveEventToAgent(
	doc: HubViewDocumentState,
	agentId: string,
	agent: HubAgentViewModel,
	event: LiveRenderEvent,
): void {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end": {
			upsertLiveMessage(doc, agentId, agent, event.messageId, event.message);
			if (event.type === "message_end") {
				delete agent.live.itemIndicesById[event.messageId];
			}
			return;
		}
		case "assistant_message_start":
		case "assistant_message_update":
		case "assistant_message_end": {
			const messageId =
				event.type === "assistant_message_start"
					? event.messageId
					: (agent.live.streamingMessageId ?? event.messageId);
			const index = upsertLiveMessage(doc, agentId, agent, messageId, event.message);
			if (event.type === "assistant_message_end") {
				delete agent.live.streamingMessageId;
				delete agent.live.streamingMessageIndex;
				delete agent.live.itemIndicesById[messageId];
			} else {
				agent.live.streamingMessageId = messageId;
				agent.live.streamingMessageIndex = index;
			}
			return;
		}
		case "tool_execution_start":
			agent.live.toolsById[event.toolCallId] = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: deepCloneJson(event.args),
			};
			pushUnique(agent.live.toolOrder, event.toolCallId);
			return;
		case "tool_execution_update": {
			const tool = ensureLiveTool(agent, event.toolCallId, event.toolName);
			syncProperty(tool, "args", event.args);
			syncProperty(tool, "partialResult", event.partialResult);
			return;
		}
		case "tool_execution_end": {
			const tool = ensureLiveTool(agent, event.toolCallId, event.toolName);
			syncProperty(tool, "result", event.result);
			tool.isError = event.isError;
			return;
		}
		case "status":
			agent.live.statusMessage = event.message;
			return;
	}
}

function upsertLiveMessage(
	doc: HubViewDocumentState,
	agentId: string,
	agent: HubAgentViewModel,
	messageId: string,
	message: AgentMessage,
): number {
	const existingIndex = agent.live.itemIndicesById[messageId];
	if (existingIndex === undefined || agent.items[existingIndex]?.type !== "message") {
		const index = agent.items.length;
		agent.items.push({ type: "message", message: createMessageView(message) });
		agent.live.itemIndicesById[messageId] = index;
		pruneAgentViewItems(agent);
		const currentIndex = agent.live.itemIndicesById[messageId] ?? Math.max(0, agent.items.length - 1);
		if (message.role === "assistant") {
			syncAssistantMessageTextBlocks(doc, agentId, currentIndex, message);
		}
		return currentIndex;
	}
	syncMessageAt(doc, agentId, existingIndex, message);
	return existingIndex;
}

function createMessageView(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant") {
		return deepCloneJson(message);
	}
	return {
		...deepCloneJson(message),
		content: message.content.map((block) =>
			block.type === "text"
				? { ...block, text: "" }
				: block.type === "thinking"
					? { ...block, thinking: "" }
					: deepCloneJson(block),
		),
	};
}

function syncMessageAt(doc: HubViewDocumentState, agentId: string, index: number, message: AgentMessage): void {
	const existing = agentMessageAt(doc, agentId, index);
	if (!existing || existing.role !== "assistant" || message.role !== "assistant") {
		syncArrayIndex(doc.agentsById[agentId]!.items, index, { type: "message", message });
		return;
	}
	syncAssistantMessageMetadata(existing, message);
	syncAssistantMessageContentShape(existing, message);
	syncAssistantMessageTextBlocks(doc, agentId, index, message);
}

function agentMessageAt(doc: HubViewDocumentState, agentId: string, index: number): AgentMessage | undefined {
	const item = doc.agentsById[agentId]?.items[index];
	return item?.type === "message" ? item.message : undefined;
}

function applySessionEventToAgent(agent: HubAgentViewModel, event: HubSessionEvent): void {
	switch (event.type) {
		case "run_state_changed":
			agent.status.isRunning = event.isRunning;
			syncOptionalProperty(agent.status, "runStartedAt", event.runStartedAt);
			syncOptionalProperty(agent.status, "lastRunStartedAt", event.lastRunStartedAt);
			syncOptionalProperty(agent.status, "lastRunEndedAt", event.lastRunEndedAt);
			syncOptionalProperty(agent.status, "lastRunDurationMs", event.lastRunDurationMs);
			syncOptionalProperty(agent.status, "lastRunEndReason", event.lastRunEndReason);
			syncOptionalProperty(agent, "lastError", event.lastError);
			syncOptionalProperty(agent.live, "statusMessage", event.lastError);
			if (event.runTiming) {
				agent.items.push({ type: "run_timing", timing: deepCloneJson(event.runTiming) });
				pruneAgentViewItems(agent);
			}
			if (!event.isRunning) {
				clearLiveToolExecutions(agent);
			}
			return;
		case "queue_changed":
			agent.queue.size = event.messages.length;
			syncArray(agent.queue.messages, event.messages);
			return;
		case "summary_changed":
			syncOptionalProperty(agent, "summary", event.summary);
			return;
		case "error":
			agent.lastError = event.message;
			agent.live.statusMessage = event.message;
			return;
		case "snapshot_updated":
			return;
	}
}

function clearLiveToolExecutions(agent: HubAgentViewModel): void {
	agent.live.toolOrder.splice(0, agent.live.toolOrder.length);
	for (const toolCallId of Object.keys(agent.live.toolsById)) {
		delete agent.live.toolsById[toolCallId];
	}
}

function pruneAgentViewItems(agent: HubAgentViewModel): void {
	const overflow = agent.items.length - MAX_AGENT_VIEW_ITEMS;
	if (overflow <= 0) {
		return;
	}
	agent.items.splice(0, overflow);
	for (const [messageId, index] of Object.entries(agent.live.itemIndicesById)) {
		if (index < overflow) {
			delete agent.live.itemIndicesById[messageId];
		} else {
			agent.live.itemIndicesById[messageId] = index - overflow;
		}
	}
	if (agent.live.streamingMessageIndex !== undefined) {
		if (agent.live.streamingMessageIndex < overflow) {
			delete agent.live.streamingMessageIndex;
			delete agent.live.streamingMessageId;
		} else {
			agent.live.streamingMessageIndex -= overflow;
		}
	}
}

function ensureLiveTool(agent: HubAgentViewModel, toolCallId: string, toolName: string): HubLiveToolExecutionViewModel {
	const existing = agent.live.toolsById[toolCallId];
	if (existing) {
		existing.toolName = toolName;
		return existing;
	}
	const tool: HubLiveToolExecutionViewModel = {
		toolCallId,
		toolName,
	};
	agent.live.toolsById[toolCallId] = tool;
	pushUnique(agent.live.toolOrder, toolCallId);
	return agent.live.toolsById[toolCallId];
}

function syncAssistantMessageMetadata(target: AssistantMessage, source: AssistantMessage): void {
	target.api = source.api;
	target.provider = source.provider;
	target.model = source.model;
	target.timestamp = source.timestamp;
	target.stopReason = source.stopReason;
	syncProperty(target as unknown as Record<string, unknown>, "usage", source.usage);
	syncOptionalProperty(target as unknown as Record<string, unknown>, "responseId", source.responseId);
	syncOptionalProperty(target as unknown as Record<string, unknown>, "errorMessage", source.errorMessage);
}

function syncAssistantMessageContentShape(target: AssistantMessage, source: AssistantMessage): void {
	while (target.content.length > source.content.length) {
		target.content.pop();
	}
	for (let i = 0; i < source.content.length; i += 1) {
		const sourceBlock = source.content[i];
		const targetBlock = target.content[i];
		if (!targetBlock || targetBlock.type !== sourceBlock.type) {
			target.content[i] =
				sourceBlock.type === "text"
					? { ...sourceBlock, text: "" }
					: sourceBlock.type === "thinking"
						? { ...sourceBlock, thinking: "" }
						: deepCloneJson(sourceBlock);
			continue;
		}
		if (sourceBlock.type === "toolCall") {
			syncProperty(targetBlock as unknown as Record<string, unknown>, "id", sourceBlock.id);
			syncProperty(targetBlock as unknown as Record<string, unknown>, "name", sourceBlock.name);
			syncProperty(targetBlock as unknown as Record<string, unknown>, "arguments", sourceBlock.arguments);
			syncOptionalProperty(
				targetBlock as unknown as Record<string, unknown>,
				"thoughtSignature",
				sourceBlock.thoughtSignature,
			);
		} else if (sourceBlock.type === "text") {
			syncOptionalProperty(
				targetBlock as unknown as Record<string, unknown>,
				"textSignature",
				sourceBlock.textSignature,
			);
		} else {
			syncOptionalProperty(
				targetBlock as unknown as Record<string, unknown>,
				"thinkingSignature",
				sourceBlock.thinkingSignature,
			);
			syncOptionalProperty(targetBlock as unknown as Record<string, unknown>, "redacted", sourceBlock.redacted);
		}
	}
}

function syncAssistantMessageTextBlocks(
	doc: HubViewDocumentState,
	agentId: string,
	messageIndex: number,
	message: AssistantMessage,
): void {
	for (let i = 0; i < message.content.length; i += 1) {
		const block = message.content[i];
		if (block.type === "text") {
			Automerge.updateText(
				doc as Automerge.Doc<unknown>,
				["agentsById", agentId, "items", messageIndex, "message", "content", i, "text"],
				block.text,
			);
		} else if (block.type === "thinking") {
			Automerge.updateText(
				doc as Automerge.Doc<unknown>,
				["agentsById", agentId, "items", messageIndex, "message", "content", i, "thinking"],
				block.thinking,
			);
		}
	}
}

function pushUnique(items: string[], item: string): void {
	if (!items.includes(item)) {
		items.push(item);
	}
}
