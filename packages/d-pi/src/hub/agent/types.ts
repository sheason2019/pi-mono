import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
	CompactionResult,
	CreateAgentSessionServicesOptions,
	LoadExtensionsResult,
	ModelCycleResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PeerConfigJsonLayers } from "../config-aggregation/types.js";
import type { HubResourceLoader } from "../resources/hub-resource-loader.js";
import type { HubSessionService } from "../session/hub-session-service.js";
import type { LiveRenderEvent } from "../transport/live-events.js";
import type { HubLogSink } from "../tui/hub-log.js";

export type MessageSourceKind = "peer" | "source" | "agent" | "host";

export interface MessageSourceContextHeader {
	label: string;
	value: string;
}

export interface MessageSource {
	kind: MessageSourceKind;
	name: string;
	sentAt?: string;
	contextHeaders?: MessageSourceContextHeader[];
}

export interface QueuedInputMessage {
	text: string;
	messageSource: MessageSource;
}

export interface MessageSourceMetadata {
	sentAt?: string;
	authTokenName?: string;
	authTokenDescription?: string;
	authUser?: string;
	authPurpose?: string;
}

export const MESSAGE_SOURCE_SECURITY_NOTE = "注意区分消息来源和人员权限范围";

function createAuthContextHeaders(metadata?: MessageSourceMetadata): MessageSourceContextHeader[] | undefined {
	const headers: MessageSourceContextHeader[] = [];
	if (metadata?.authTokenName || metadata?.authTokenDescription || metadata?.authUser || metadata?.authPurpose) {
		headers.push({ label: "security note", value: MESSAGE_SOURCE_SECURITY_NOTE });
	}
	if (metadata?.authTokenName) {
		headers.push({ label: "message source auth token", value: metadata.authTokenName });
	}
	if (metadata?.authTokenDescription) {
		headers.push({ label: "message source auth token description", value: metadata.authTokenDescription });
	}
	if (metadata?.authUser) {
		headers.push({ label: "message source user", value: metadata.authUser });
	}
	if (metadata?.authPurpose) {
		headers.push({ label: "message source purpose", value: metadata.authPurpose });
	}
	return headers.length > 0 ? headers : undefined;
}

function getSentAt(metadata?: MessageSourceMetadata): string | undefined {
	return metadata?.sentAt;
}

function withDeliveryContext(source: MessageSource, metadata?: MessageSourceMetadata): MessageSource {
	const sentAt = getSentAt(metadata);
	const contextHeaders = createAuthContextHeaders(metadata);
	return {
		...source,
		...(sentAt ? { sentAt } : {}),
		...(contextHeaders ? { contextHeaders } : {}),
	};
}

export interface InputQueueFlushResult {
	flushed: boolean;
	messages: number;
}

export function createPeerMessageSource(peerId: string, metadata?: MessageSourceMetadata): MessageSource {
	return withDeliveryContext({ kind: "peer", name: peerId }, metadata);
}

export function createHostMessageSource(hostId = "host", metadata?: MessageSourceMetadata): MessageSource {
	return withDeliveryContext({ kind: "host", name: hostId.trim() || "host" }, metadata);
}

export function createSourceMessageSource(name: string): MessageSource {
	return { kind: "source", name };
}

export function createAgentMessageSource(agentId: string): MessageSource {
	return { kind: "agent", name: agentId };
}

export function formatMessageSourceLabel(source: MessageSource): string {
	return `${source.kind}/${source.name}`;
}

export function messageSourceHeaderPrefix(source: MessageSource): string {
	const lines = [`[message source: ${formatMessageSourceLabel(source)}]`];
	if (source.sentAt) {
		lines.push(`[message sent at: ${source.sentAt}]`);
	}
	for (const header of source.contextHeaders ?? []) {
		if (header.label.trim() && header.value.trim()) {
			lines.push(`[${header.label}: ${header.value}]`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export interface CreateHubAgentAdapterOptions {
	agentId?: string;
	sessionService: HubSessionService;
	tools: ToolDefinition[];
	cwd?: string;
	agentDir?: string;
	configLayers?: PeerConfigJsonLayers[];
	services?: AgentSessionServices;
	resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
	prepareServices?: (services: AgentSessionServices) => Promise<void> | void;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	/**
	 * Optional callback invoked from `reload()` so the hub can re-read external
	 * runtime configuration (for example `.pi/sources.json`) alongside the agent
	 * session reload.
	 */
	refreshSources?: () => Promise<void>;
	/**
	 * Optional callback invoked from `reload()` after sources refresh, to
	 * restart the MCP host and refresh MCP-derived tools in `customTools`.
	 */
	refreshMcp?: () => Promise<void>;
	/**
	 * Called immediately before the automatic input queue pump consumes queued
	 * messages. Return false when the adapter was replaced and this pump should
	 * stop so the replacement can continue with the persisted queue.
	 */
	beforeInputQueueDrain?: () => Promise<boolean | undefined> | boolean | undefined;
	logs?: HubLogSink;
}

export interface HubAgentAdapterStatus {
	diagnostics: readonly AgentSessionRuntimeDiagnostic[];
}

export interface HubAgentAdapterBindings {
	session: AgentSession;
	services: AgentSessionServices;
	extensionsResult: LoadExtensionsResult;
	resourceLoader: HubResourceLoader;
}

export interface HubAgentAdapterApi extends HubAgentAdapterStatus, HubAgentAdapterBindings {
	enqueueFromPeer(peerId: string, text: string, metadata?: MessageSourceMetadata): Promise<void>;
	enqueueFromHost(hostId: string, text: string, metadata?: MessageSourceMetadata): Promise<void>;
	enqueueFromSource(sourceName: string, text: string): Promise<void>;
	enqueueFromAgent(agentId: string, text: string): Promise<void>;
	continueCurrentTranscript(): void;
	requestInputQueuePump(): void;
	flushInputQueue(): Promise<InputQueueFlushResult>;
	dequeue(): Promise<QueuedInputMessage[]>;
	abort(): Promise<void>;
	setModel(model: Model<Api>): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;
	setThinkingLevel(level: ThinkingLevel): void;
	cycleThinkingLevel(): ThinkingLevel | undefined;
	compact(customInstructions?: string): Promise<CompactionResult>;
	reload(): Promise<void>;
	getAvailableModels(): Promise<Model<Api>[]>;
	subscribeLiveEvents(listener: (event: LiveRenderEvent) => void): () => void;
	dispose(): void;
}
