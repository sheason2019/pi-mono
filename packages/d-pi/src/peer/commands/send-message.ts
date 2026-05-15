import { hostname } from "node:os";
import type { AssistantMessage } from "@sheason/pi-ai";
import { HUB_PROTOCOL_VERSION, type HubAgentViewItem, type HubAgentViewModel } from "../../hub/index.js";
import { SocketPeerClient, type SocketPeerClientOptions } from "../client/socket-client.js";
import { type PeerAppSnapshot, PeerAppState } from "../state/peer-app-state.js";
import { PeerUiState } from "../state/peer-ui-state.js";

const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ONE_SHOT_PEER_ID = "d-pi-peer-message";

export interface SendOneShotPeerMessageOptions {
	hubUrl: string;
	agentId?: string;
	peerId?: string;
	token?: string;
	message: string;
	noResponse?: boolean;
	version: string;
	responseTimeoutMs?: number;
	onHandshakeLog?: SocketPeerClientOptions["onHandshakeLog"];
}

interface ResponseBaseline {
	itemCount: number;
	lastError?: string;
}

type TextualMessage = { content: string | Array<{ type: string; text?: string }> };

export async function sendOneShotPeerMessage(options: SendOneShotPeerMessageOptions): Promise<string | undefined> {
	const message = options.message.trim();
	if (!message) {
		throw new Error("Message text is required.");
	}

	const appState = new PeerAppState();
	const uiState = new PeerUiState();
	const hostId = options.peerId?.trim() || DEFAULT_ONE_SHOT_PEER_ID;
	const client = new SocketPeerClient({
		hubUrl: options.hubUrl,
		hello: {
			peerId: hostId,
			...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
			token: options.token ?? "",
			clientKind: "host",
			protocolVersion: HUB_PROTOCOL_VERSION,
			displayName: hostId,
			version: options.version,
			platform: process.platform,
			hostname: hostname(),
			cwd: process.cwd(),
			executorEnabled: false,
		},
		appState,
		uiState,
		onHandshakeLog: options.onHandshakeLog,
		reconnection: false,
	});

	try {
		await client.connect();
		let response: Promise<string> | undefined;
		if (options.noResponse !== true) {
			await client.waitForInitialSync();
			response = waitForOneShotResponse(appState, {
				hostId,
				message,
				baseline: createResponseBaseline(appState.getSnapshot()),
				timeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
			});
		}
		await client.queueWrite(message);
		await client.queueFlush();
		return response ? await response : undefined;
	} finally {
		await client.disconnect().catch(() => {});
	}
}

function createResponseBaseline(snapshot: PeerAppSnapshot): ResponseBaseline {
	const agent = snapshot.selectedAgent;
	if (!agent) {
		throw new Error("Hub session sync did not include a selected agent.");
	}
	return {
		itemCount: agent.items.length,
		lastError: agent.lastError,
	};
}

function waitForOneShotResponse(
	appState: PeerAppState,
	options: { hostId: string; message: string; baseline: ResponseBaseline; timeoutMs: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const settle = (callback: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			unsubscribe?.();
			callback();
		};
		const timeoutId = setTimeout(() => {
			settle(() => reject(new Error(`Timed out waiting for assistant response after ${options.timeoutMs}ms.`)));
		}, options.timeoutMs);
		timeoutId.unref?.();

		const evaluate = (snapshot: PeerAppSnapshot): void => {
			const result = findOneShotResponse(snapshot.selectedAgent, options);
			if (result.type === "pending") {
				return;
			}
			if (result.type === "error") {
				settle(() => reject(new Error(result.message)));
				return;
			}
			settle(() => resolve(result.text));
		};

		unsubscribe = appState.subscribe(evaluate);
		evaluate(appState.getSnapshot());
	});
}

type ResponseSearchResult =
	| { type: "pending" }
	| { type: "error"; message: string }
	| { type: "response"; text: string };

function findOneShotResponse(
	agent: HubAgentViewModel | undefined,
	options: { hostId: string; message: string; baseline: ResponseBaseline },
): ResponseSearchResult {
	if (!agent) {
		return { type: "pending" };
	}
	const items = agent.items.slice(options.baseline.itemCount);
	const userIndex = items.findIndex((item) => isMatchingHostUserMessage(item, options.hostId, options.message));
	if (userIndex === -1) {
		return { type: "pending" };
	}
	const assistant = findLastAssistantMessage(items.slice(userIndex + 1));
	if (agent.status.isRunning) {
		return { type: "pending" };
	}
	if (!assistant && agent.lastError && agent.lastError !== options.baseline.lastError) {
		return { type: "error", message: agent.lastError };
	}
	if (!assistant) {
		return { type: "pending" };
	}
	return { type: "response", text: getAssistantText(assistant) };
}

function isMatchingHostUserMessage(item: HubAgentViewItem, hostId: string, message: string): boolean {
	if (item.type !== "message" || item.message.role !== "user") {
		return false;
	}
	const source = "messageSource" in item.message ? item.message.messageSource : undefined;
	return getMessageText(item.message) === message && source?.kind === "host" && source.name === hostId;
}

function findLastAssistantMessage(items: HubAgentViewItem[]): AssistantMessage | undefined {
	for (let i = items.length - 1; i >= 0; i -= 1) {
		const item = items[i];
		if (item?.type === "message" && item.message.role === "assistant") {
			return item.message as AssistantMessage;
		}
	}
	return undefined;
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getMessageText(message: TextualMessage): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
