import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionFactory, MessageRenderer } from "@sheason/pi-coding-agent";
import { getMarkdownTheme } from "@sheason/pi-coding-agent";
import type {
	AgentStatus,
	GroupArchitectureEntry,
	GroupArchitectureSnapshot,
	SourceInfo,
	WorkerToHubMessage,
} from "../types.ts";
import { createCreateAgentTool } from "./create-agent.ts";
import { createCreateSourceTool } from "./create-source.ts";
import { createDestroyAgentTool } from "./destroy-agent.ts";
import { createDestroySourceTool } from "./destroy-source.ts";
import { createGroupArchitectureTool } from "./group-architecture.ts";
import { createBashRemoteTool } from "./bash-remote.ts";
import { HubChannel } from "./hub-channel.ts";
import { createListSourcesTool } from "./list-sources.ts";
import type { MessageMeta } from "./message-meta.ts";
import { extractMeta, injectMeta } from "./message-meta.ts";
import { createSendMessageTool } from "./send-message.ts";
import { createSubscribeSourceTool } from "./subscribe-source.ts";
import { createUnsubscribeSourceTool } from "./unsubscribe-source.ts";

// ── Config types ──────────────────────────────────────────────────────

export interface DPiWorkerConfig {
	mode: "worker";
	/**
	 * The worker's identity — the agent's NAME. Names are the unique
	 * key (see the "name is identity" rationale in the changelog);
	 * there is no separate UUID. The worker uses this to label every
	 * IPC message and every persisted `agent.json`.
	 */
	agentName: string;
	postToHub: (message: WorkerToHubMessage) => void;
}

export interface DPiClientConfig {
	mode: "client";
	hubUrl: string;
	/**
	 * The currently connected agent's NAME (same identity rule as
	 * DPiWorkerConfig.agentName). Used by the /agents selector to
	 * mark the active entry.
	 */
	currentAgentName?: string;
	/**
	 * Bearer token for the hub. Required when the hub is running with auth
	 * enabled (the default). Omit in dev mode (hub without auth).
	 */
	authToken?: string;
}

export type DPiExtensionConfig = DPiWorkerConfig | DPiClientConfig;

/** File where the selected agent name is written before triggering shutdown.
 *  The parent process checks for this file to determine if the child exited
 *  due to an agent switch (file exists) or a normal quit (file absent). */
export const AGENT_SWITCH_FILE = join(tmpdir(), "d-pi-agent-switch.txt");

// ── Unified factory ──────────────────────────────────────────────────

/**
 * Create the d-pi extension factory.
 *
 * Unified entry point for both worker and client modes. The factory
 * conditionally registers tools, commands, and message handlers based
 * on the provided config mode.
 *
 * @param config - Worker config (IPC tools + message handler) or client config (HTTP /agents)
 * @returns The ExtensionFactory and optionally the HubChannel (worker mode only)
 */
export function createDPiExtension(config: DPiExtensionConfig): { factory: ExtensionFactory; channel?: HubChannel } {
	if (config.mode === "worker") {
		const channel = new HubChannel(config.agentName, config.postToHub);
		const factory = createWorkerFactory(channel);
		return { factory, channel };
	}
	const factory = createClientFactory(config);
	return { factory };
}

// ── Worker factory ───────────────────────────────────────────────────

function createWorkerFactory(channel: HubChannel): ExtensionFactory {
	return (pi) => {
		// Shared: message renderer
		registerDPiMessageRenderer(pi);

		// Worker only: tools
		pi.registerTool(createSendMessageTool(channel));
		pi.registerTool(createCreateAgentTool(channel));
		pi.registerTool(createDestroyAgentTool(channel));
		pi.registerTool(createGroupArchitectureTool(channel));
		pi.registerTool(createCreateSourceTool(channel));
		pi.registerTool(createDestroySourceTool(channel));
		pi.registerTool(createSubscribeSourceTool(channel));
		pi.registerTool(createUnsubscribeSourceTool(channel));
		pi.registerTool(createListSourcesTool(channel));
		// `bash_remote` is always registered so the LLM has a stable
		// surface for "execute on the connected client". If no client
		// is bound, calls fail with a clear error from the hub's
		// `_handleToolCall("call_executor")` case — the tool's
		// description and the system prompt guide the LLM to prefer
		// it whenever a connect session is active.
		pi.registerTool(createBashRemoteTool(channel));

		// Server-side /sources and /agents commands — register the command
		// names so they appear in the TUI slash menu (via the /commands
		// proxy). The actual execution is handled by the client-side
		// handlers loaded via the extension sync mechanism; these
		// server-side registrations are no-op placeholders so the server's
		// `/commands` response naturally includes them. Previously the hub
		// gateway intercepted GET /commands to inject /agents manually;
		// unifying the registration here removes that hack.
		pi.registerCommand("sources", {
			description: "List all registered sources",
			async handler(_args: string, _ctx): Promise<void> {
				// Intentionally a no-op: the client extension intercepts this
				// command on the TUI side. The TUI's command flow checks the
				// client extension runner before sending to the agent.
			},
		});
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the group architecture",
			async handler(_args: string, _ctx): Promise<void> {
				// Intentionally a no-op: the client extension intercepts this
				// command on the TUI side. The TUI's command flow checks the
				// client extension runner before sending to the agent.
			},
		});

		// Worker only: handle incoming messages through the extension event bus
		pi.on("input", (event) => {
			if (event.source !== "interactive") {
				return { action: "continue" };
			}
			const metaContent = injectMeta(event.text, "connect");
			const extracted = extractMeta(metaContent);
			// Connect-mode / TUI input maps streaming behaviour to the
			// "next" vs "steer" mode (next = turn-start injection, steer
			// = interrupt). For non-streaming (i.e. a normal Enter key
			// press arriving as a complete user message), default to
			// "next" — équivalent to triggerTurn=true.
			// Same fix as `onIncomingMessage` below: always set
			// `triggerTurn: true` so a TUI input can wake an idle agent.
			// When the agent is already streaming, the downstream
			// `sendCustomMessage()` interprets `deliverAs: "steer"` as
			// "queue into the steering queue"; the streaming check is in
			// the session, not here. So we get the right behavior at
			// both ends: idle agents get a new turn immediately, busy
			// agents get the message queued as a steer-or-followUp
			// depending on `event.streamingBehavior`.
			const isSteer = event.streamingBehavior === "steer";
			pi.sendMessage(
				{
					customType: "d-pi-message",
					content: metaContent,
					display: true,
					details: extracted?.meta,
				},
				{ triggerTurn: true, deliverAs: isSteer ? ("steer" as const) : undefined },
			);
			return { action: "handled" };
		});

		channel.onIncomingMessage((content, sourceName, mode) => {
			if (sourceName) {
				process.stderr.write(`[d-pi extension] Received source message from "${sourceName}"\n`);
			}
			const metaContent = extractMeta(content)
				? content
				: injectMeta(content, sourceName ? "source" : "connect", undefined, { sourceName });
			const extracted = extractMeta(metaContent);
			// Routing decision lives in SourceManager (parsed + coerced from
			// params.mode on the validated JSONRPC notification, mirroring
			// the TUI's Enter / Ctrl+Enter vocabulary). The extension maps
			// the source-declared mode to `pi.sendMessage` options, but
			// always with `triggerTurn: true` so a source message can
			// wake an idle agent. Without the trigger flag, `sendCustomMessage`
			// in the agent's session only queues when the agent is already
			// streaming; if the agent is idle, the message would land as a
			// bare entry in the session log and the agent would never
			// actually process it (Bug 2). The `deliverAs` field's
			// meaning is "how to queue this if the agent is already mid-turn";
			// when the agent is idle, every source message IS a new turn.
			//
			// The downstream sendCustomMessage() still interprets
			// `deliverAs: "steer"` as "queue into the steering queue if
			// currently streaming" — and the streaming detection is in the
			// session, not here — so we get the right behavior at both
			// ends: idle agents get a new turn immediately, busy agents
			// get the message queued as a steer-or-followUp depending on
			// `mode`.
			pi.sendMessage(
				{
					customType: "d-pi-message",
					content: metaContent,
					display: true,
					details: extracted?.meta,
				},
				{ triggerTurn: true, deliverAs: mode === "steer" ? "steer" : undefined },
			);
		});
	};
}

// ── Client factory ───────────────────────────────────────────────────

function createClientFactory(config: DPiClientConfig): ExtensionFactory {
	return (pi) => {
		// Shared: message renderer
		registerDPiMessageRenderer(pi);

		// Client only: /sources command — show a panel listing all sources
		// (Dual-side registration: the server-side registration in the worker
		// factory also lists it in /commands so it appears in the TUI slash
		// menu. The TUI's command flow checks the client extension runner
		// first, so this handler is what actually runs.)
		pi.registerCommand("sources", {
			description: "List all registered sources",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const headers: Record<string, string> = {};
					if (config.authToken) {
						headers.Authorization = `Bearer ${config.authToken}`;
					}
					const response = await fetch(`${config.hubUrl}/_hub/sources`, { headers });
					if (!response.ok) {
						ctx.ui.notify(`Failed to fetch sources: ${response.status}`, "error");
						return;
					}
					const sources = (await response.json()) as SourceInfo[];
					if (sources.length === 0) {
						ctx.ui.notify("No sources registered. Use create_source tool to register one.", "info");
						return;
					}
					const options = sources.map(
						(s) => `  ${s.name} [${s.status}] command="${s.command}" subscribers=${s.subscriberCount}`,
					);
					const title = `Sources (${sources.length})`;
					await ctx.ui.select(title, options);
				} catch (err) {
					ctx.ui.notify(`Failed to list sources: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});

		// Client only: /agents command
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the group architecture",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const headers: Record<string, string> = {};
					if (config.authToken) {
						headers.Authorization = `Bearer ${config.authToken}`;
					}
					const response = await fetch(`${config.hubUrl}/_hub/group-architecture`, { headers });
					if (!response.ok) {
						ctx.ui.notify(`Failed to fetch group architecture: ${response.status}`, "error");
						return;
					}
					const network = (await response.json()) as GroupArchitectureSnapshot;

					if (network.agents.length === 0) {
						ctx.ui.notify("No agents in group architecture", "info");
						return;
					}

					// Build tree-ordered options by walking from root
					// (network uses `name` as the key, not a separate id)
					const agentMap = new Map(network.agents.map((a) => [a.name, a]));
					const options: string[] = [];

					const walkTree = (agentName: string, depth: number, isLast = true): void => {
						const agent = agentMap.get(agentName);
						if (!agent) return;
						options.push(formatAgentEntry(agent, depth, isLast, agent.name === config.currentAgentName));
						for (let i = 0; i < agent.children.length; i++) {
							walkTree(agent.children[i], depth + 1, i === agent.children.length - 1);
						}
					};

					// Walk from root first
					if (network.rootName) {
						walkTree(network.rootName, 0);
					}
					// Then add any orphan agents (no parent in the tree)
					const visited = new Set<string>();
					const collectVisited = (agentName: string): void => {
						visited.add(agentName);
						const agent = agentMap.get(agentName);
						if (agent) for (const childName of agent.children) collectVisited(childName);
					};
					if (network.rootName) collectVisited(network.rootName);
					for (const agent of network.agents) {
						if (!visited.has(agent.name)) {
							options.push(formatAgentEntry(agent, 0, true, agent.name === config.currentAgentName));
						}
					}

					const title = `Switch to agent (${network.agents.length} agent${network.agents.length !== 1 ? "s" : ""})`;
					const selected = await ctx.ui.select(title, options);
					if (!selected) return;

					// Extract agent name from the tab-separated suffix
					const agentName = parseAgentName(selected);
					if (!agentName) return;

					// Write selected agent name to temp file, then trigger graceful shutdown
					writeFileSync(AGENT_SWITCH_FILE, agentName, "utf-8");
					ctx.shutdown();
				} catch (err) {
					ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};
}

function registerDPiMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<MessageMeta>("d-pi-message", (message, _options, theme) => {
		const rawText = messageContentToText(message.content);
		const extracted = extractMeta(rawText);
		const meta = extracted?.meta ?? message.details;
		if (!meta) {
			return undefined;
		}
		const textContent = extracted?.text ?? rawText;

		// Build meta label: sourceType[:name] · authName · timeString.
		// Contract: at most one of {connectId, sourceName, agentName} is
		// set per message, keyed off sourceType — `connectId` only
		// appears with sourceType "connect", `sourceName` with "source",
		// and `agentName` with "agent". The chain below relies on that
		// mutual exclusion, so do not generalize it (e.g. by appending
		// more suffixes) without also widening the contract.
		let source: string = meta.sourceType;
		if (meta.sourceType === "connect" && meta.connectId) {
			source = `${source} ${meta.connectId}`;
		} else if (meta.sourceName) {
			source = `${source}:${meta.sourceName}`;
		} else if (meta.agentName) {
			source = `${source}:${meta.agentName}`;
		}
		const headerParts = [source, meta.auth?.name, meta.createTime].filter((part) => part?.trim());

		const container = new Container();
		container.addChild(new Text(theme.fg("warning", headerParts.join(" · ")), 0, 0));
		if (textContent) {
			const box = new Box(1, 1, (t: string) => theme.bg("userMessageBg", t));
			box.addChild(
				new Markdown(textContent, 0, 0, getMarkdownTheme(), {
					color: (t: string) => theme.fg("userMessageText", t),
				}),
			);
			container.addChild(box);
		}
		return container;
	});
}

function messageContentToText(content: Parameters<MessageRenderer<MessageMeta>>[0]["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (part.type === "text") {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n");
}

// ── Agent selector helpers (from client-extension.ts) ────────────────

/** Map agent status to a visual indicator. */
function statusIndicator(status: AgentStatus): string {
	switch (status) {
		case "busy":
			return "\u25CF"; // ●
		case "ready":
			return "\u25CB"; // ○
		case "starting":
			return "\u25CC"; // ◌
		case "error":
			return "\u2715"; // ✕
		default:
			return "\u25CB"; // ○ fallback
	}
}

/** Format a single agent entry for the selector. */
function formatAgentEntry(agent: GroupArchitectureEntry, depth: number, isLast: boolean, isCurrent: boolean): string {
	let indent = "";
	if (depth > 0) {
		indent = "\u2502 ".repeat(depth - 1); // │ for ancestor levels
		indent += isLast ? "\u2514 " : "\u251C "; // └ or ├ for this level
	}
	const indicator = statusIndicator(agent.status);
	const model = agent.model ? ` (${agent.model})` : "";
	const current = isCurrent ? " \u25C0" : ""; // ◀
	return `${indent}${indicator} ${agent.name}${model}${current}\t${agent.name}`;
}

/** Extract agent name from a formatted selector entry (after the tab). */
function parseAgentName(selected: string): string | undefined {
	const tabIdx = selected.lastIndexOf("\t");
	if (tabIdx === -1) return undefined;
	return selected.slice(tabIdx + 1);
}

export { HubChannel };
export { createReloadExtension, createReloadTools, type ReloadToolsDeps } from "./reload-tools.ts";
