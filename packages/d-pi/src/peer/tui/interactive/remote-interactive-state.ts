import { HUB_DEFAULT_AGENT_ID } from "../../constants.js";
import type { PeerAppSnapshot } from "../../state/peer-app-state.js";
import type { PeerUiSnapshot } from "../../state/peer-ui-state.js";
import type {
	RemoteInteractiveCommandInfo,
	RemoteInteractiveFooterView,
	RemoteInteractiveLiveView,
	RemoteInteractiveSessionView,
	RemoteInteractiveStatusView,
	RemoteInteractiveView,
} from "./remote-interactive-view.js";

export interface CreateRemoteInteractiveViewOptions {
	peerId: string;
	cwd: string;
	visibleCommands: readonly RemoteInteractiveCommandInfo[];
	/** `peer:hello` agentId (if any); used for the footer until `hub:welcome` is received. */
	helloAgentId?: string;
}

export function createRemoteInteractiveView(
	app: PeerAppSnapshot,
	ui: PeerUiSnapshot,
	options: CreateRemoteInteractiveViewOptions,
): RemoteInteractiveView {
	const session = app.selectedAgent ? mapAgentSession(app.selectedAgent) : undefined;
	const live = mapLive(app.live);
	const footer = createFooterView(
		session,
		live,
		app.peers.length,
		options.peerId,
		options.cwd,
		app.welcome?.sessionId,
		resolveBoundAgentId(app, options.helloAgentId),
	);
	const status = createStatusView(ui, session, live);
	const agents =
		app.view && Array.isArray(app.view.agentOrder) && app.view.agentsById
			? filterScopedAgentIds(app.view.agentOrder, app.view.agentsById, app.welcome?.scopeRootAgentId)
					.map((agentId) => {
						const agent = app.view?.agentsById[agentId];
						if (!agent) {
							return undefined;
						}
						return {
							id: agentId,
							parentId: agent.parentId,
							kind: agent.kind,
							lifecycle: agent.lifecycle,
							name: agent.name,
							isRunning: agent.status.isRunning,
							messageCount: agent.items.filter((item) => item.type === "message").length,
							model: agent.context.model,
						};
					})
					.filter((agent): agent is NonNullable<typeof agent> => agent !== undefined)
			: [];

	return {
		connection: {
			state: ui.connectionState,
			message: ui.connectionMessage,
		},
		welcome: app.welcome,
		session,
		live,
		agents,
		peers: app.peers,
		footer,
		status,
		commands: options.visibleCommands,
	};
}

function resolveBoundAgentId(app: PeerAppSnapshot, helloAgentId: string | undefined): string {
	const fromWelcome = app.welcome?.agentId;
	if (fromWelcome !== undefined && fromWelcome !== "") {
		return fromWelcome;
	}
	if (typeof helloAgentId === "string" && helloAgentId.trim() !== "") {
		return helloAgentId.trim();
	}
	return HUB_DEFAULT_AGENT_ID;
}

function filterScopedAgentIds(
	agentIds: readonly string[],
	agentsById: NonNullable<PeerAppSnapshot["view"]>["agentsById"],
	scopeRootAgentId: string | undefined,
): string[] {
	if (!scopeRootAgentId || scopeRootAgentId === HUB_DEFAULT_AGENT_ID) {
		return [...agentIds];
	}
	return agentIds.filter((agentId) => isAgentInScope(agentId, scopeRootAgentId, agentsById));
}

function isAgentInScope(
	agentId: string,
	scopeRootAgentId: string,
	agentsById: NonNullable<PeerAppSnapshot["view"]>["agentsById"],
): boolean {
	let currentId: string | undefined = agentId;
	const seen = new Set<string>();
	while (currentId && !seen.has(currentId)) {
		if (currentId === scopeRootAgentId) {
			return true;
		}
		seen.add(currentId);
		currentId = agentsById[currentId]?.parentId;
	}
	return false;
}

function mapAgentSession(agent: NonNullable<PeerAppSnapshot["selectedAgent"]>): RemoteInteractiveSessionView {
	return {
		sessionId: agent.sessionId,
		cwd: agent.cwd,
		protocolVersion: agent.protocolVersion,
		sessionFile: agent.sessionFile ?? "",
		items: agent.items.map((item) => ({ ...item })),
		availableModels: [...agent.availableModels],
		availableThinkingLevels: [...agent.availableThinkingLevels],
		isRunning: agent.status.isRunning,
		pendingToolCallIds: [...agent.context.pendingToolCallIds],
		queuedMessages: [...agent.queue.messages],
		model: agent.context.model,
		thinkingLevel: agent.context.thinkingLevel,
		contextUsage: agent.context.contextUsage,
		lastError: agent.lastError,
		diagnostics: [...agent.diagnostics],
		runStartedAt: agent.status.runStartedAt,
		lastRunStartedAt: agent.status.lastRunStartedAt,
		lastRunEndedAt: agent.status.lastRunEndedAt,
		lastRunDurationMs: agent.status.lastRunDurationMs,
		lastRunEndReason: agent.status.lastRunEndReason,
	};
}

function mapLive(snapshot: PeerAppSnapshot["live"] | undefined): RemoteInteractiveLiveView {
	return {
		streamingMessageId: snapshot?.streamingMessageId,
		streamingMessageIndex: snapshot?.streamingMessageIndex,
		streamingMessage: snapshot?.streamingMessage,
		toolExecutions: (snapshot?.toolExecutions ?? []).map((execution) => ({
			...execution,
			args: execution.args ? { ...execution.args } : undefined,
		})),
		statusMessage: snapshot?.statusMessage,
	};
}

function createFooterView(
	session: RemoteInteractiveSessionView | undefined,
	live: RemoteInteractiveLiveView,
	peerCount: number,
	peerId: string,
	cwd: string,
	sessionId: string | undefined,
	boundAgentId: string,
): RemoteInteractiveFooterView {
	const queuedCount = session?.queuedMessages?.length ?? 0;
	const pendingToolCount = Math.max(session?.pendingToolCallIds.length ?? 0, live.toolExecutions.length);
	const matchedModel = session?.model
		? session.availableModels.find(
				(model) => model.provider === session.model?.provider && model.modelId === session.model?.modelId,
			)
		: undefined;
	const contextWindow = session?.contextUsage?.contextWindow ?? matchedModel?.contextWindow;

	return {
		cwd,
		modelLabel: session?.model ? `${session.model.provider}/${session.model.modelId}` : "no-model",
		queueSummary: `queued ${queuedCount}`,
		pendingToolCount,
		peerCount,
		isRunning: session?.isRunning ?? false,
		peerId,
		boundAgentId,
		sessionId,
		contextWindow,
		contextUsage: session?.contextUsage,
	};
}

function createStatusView(
	ui: PeerUiSnapshot,
	session: RemoteInteractiveSessionView | undefined,
	live: RemoteInteractiveLiveView,
): RemoteInteractiveStatusView {
	return {
		connectionMessage: ui.connectionState === "connected" ? undefined : ui.connectionMessage,
		diagnostics: session?.diagnostics ?? [],
		lastError: session?.lastError,
		liveStatusMessage: ui.isCancelling && session?.isRunning ? "Cancelling..." : live.statusMessage,
		crdtResyncMessage: ui.isCrdtResyncing ? "resyncing session state" : undefined,
	};
}
