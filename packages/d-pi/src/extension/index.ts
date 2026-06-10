import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory, MessageRenderer } from "@sheason/pi-coding-agent";
import { getMarkdownTheme } from "@sheason/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@sheason/pi-tui";
import type { AgentStatus, GroupArchitectureEntry, GroupArchitectureSnapshot, SourceInfo, WorkerToHubMessage } from "../types.ts";
import { createGroupArchitectureTool } from "./group-architecture.ts";
import { createCreateAgentTool } from "./create-agent.ts";
import { createCreateSourceTool } from "./create-source.ts";
import { createDestroyAgentTool } from "./destroy-agent.ts";
import { createDestroySourceTool } from "./destroy-source.ts";
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
	agentId: string;
	postToHub: (message: WorkerToHubMessage) => void;
}

export interface DPiClientConfig {
	mode: "client";
	hubUrl: string;
	currentAgentId?: string;
	/**
	 * Bearer token for the hub. Required when the hub is running with auth
	 * enabled (the default). Omit in dev mode (hub without auth).
	 */
	authToken?: string;
}

export type DPiExtensionConfig = DPiWorkerConfig | DPiClientConfig;

/** File where the selected agent ID is written before triggering shutdown.
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
		const channel = new HubChannel(config.agentId, config.postToHub);
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
			const options = event.streamingBehavior ? { deliverAs: event.streamingBehavior } : { triggerTurn: true };
			pi.sendMessage(
				{
					customType: "d-pi-message",
					content: metaContent,
					display: true,
					details: extracted?.meta,
				},
				options,
			);
			return { action: "handled" };
		});

		channel.onIncomingMessage((content, sourceName, deliverAs, drainMode) => {
			if (sourceName) {
				process.stderr.write(`[d-pi extension] Received source message from "${sourceName}"\n`);
			}
			const metaContent = extractMeta(content)
				? content
				: injectMeta(content, sourceName ? "source" : "connect", undefined, { sourceName });
			const extracted = extractMeta(metaContent);
			// Routing decision lives in SourceManager (parsed + coerced from
			// params.deliverAs on the validated JSONRPC notification).
			// Extension just maps the source-declared mode to pi.sendMessage
			// options — no "is agent running?" fallback, no per-event
			// branching. The 1:1 mapping is:
			//   steer    → { deliverAs: "steer" }    → /steer endpoint
			//   followUp → { deliverAs: "followUp" } → /prompt endpoint
			//   prompt   → { triggerTurn: true }    → /prompt (new turn)
			const options: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean } =
				deliverAs === "steer"
					? { deliverAs: "steer" }
					: deliverAs === "prompt"
						? { triggerTurn: true }
						: { deliverAs: "followUp" };
			// drainMode is accepted here and flows through the IPC chain,
			// but the current upstream coding-agent `pi.sendMessage` API
			// has no slot for it (a follow-up PR to packages/coding-agent
			// will expose drainMode on sendCustomMessage). Until that
			// lands the extension just logs the value for observability
			// and drops it on the floor — the schema is in place so
			// source-side declarations don't get silently lost.
			if (drainMode !== undefined) {
				process.stderr.write(`[d-pi extension] (passthrough) drainMode=${drainMode}\n`);
			}
			pi.sendMessage(
				{
					customType: "d-pi-message",
					content: metaContent,
					display: true,
					details: extracted?.meta,
				},
				options,
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
					const agentMap = new Map(network.agents.map((a) => [a.id, a]));
					const options: string[] = [];

					const walkTree = (agentId: string, depth: number, isLast = true): void => {
						const agent = agentMap.get(agentId);
						if (!agent) return;
						options.push(formatAgentEntry(agent, depth, isLast, agent.id === config.currentAgentId));
						for (let i = 0; i < agent.children.length; i++) {
							walkTree(agent.children[i], depth + 1, i === agent.children.length - 1);
						}
					};

					// Walk from root first
					if (network.rootId) {
						walkTree(network.rootId, 0);
					}
					// Then add any orphan agents (no parent in the tree)
					const visited = new Set<string>();
					const collectVisited = (agentId: string): void => {
						visited.add(agentId);
						const agent = agentMap.get(agentId);
						if (agent) for (const childId of agent.children) collectVisited(childId);
					};
					if (network.rootId) collectVisited(network.rootId);
					for (const agent of network.agents) {
						if (!visited.has(agent.id)) {
							options.push(formatAgentEntry(agent, 0, true, agent.id === config.currentAgentId));
						}
					}

					const title = `Switch to agent (${network.agents.length} agent${network.agents.length !== 1 ? "s" : ""})`;
					const selected = await ctx.ui.select(title, options);
					if (!selected) return;

					// Extract agent ID from the tab-separated suffix
					const agentId = parseAgentId(selected);
					if (!agentId) return;

					// Write selected agent ID to temp file, then trigger graceful shutdown
					writeFileSync(AGENT_SWITCH_FILE, agentId, "utf-8");
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
		// Contract: at most one of {connectId, sourceName, agentId} is set per
		// message, keyed off sourceType — `connectId` only appears with
		// sourceType "connect", `sourceName` with "source", and `agentId`
		// with "agent". The chain below relies on that mutual exclusion, so
		// do not generalize it (e.g. by appending more suffixes) without also
		// widening the contract.
		let source: string = meta.sourceType;
		if (meta.sourceType === "connect" && meta.connectId) {
			source = `${source} ${meta.connectId}`;
		} else if (meta.sourceName) {
			source = `${source}:${meta.sourceName}`;
		} else if (meta.agentId) {
			source = `${source}:${meta.agentId}`;
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
	return `${indent}${indicator} ${agent.name}${model}${current}\t${agent.id}`;
}

/** Extract agent ID from a formatted selector entry (after the tab). */
function parseAgentId(selected: string): string | undefined {
	const tabIdx = selected.lastIndexOf("\t");
	if (tabIdx === -1) return undefined;
	return selected.slice(tabIdx + 1);
}

export { HubChannel };
export { createReloadExtension, createReloadTools, type ReloadToolsDeps } from "./reload-tools.ts";
