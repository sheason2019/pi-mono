import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory, MessageRenderer } from "@sheason/pi-coding-agent";
import { getMarkdownTheme } from "@sheason/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@sheason/pi-tui";
import type { AgentNetworkEntry, AgentNetworkSnapshot, AgentStatus, SourceInfo, WorkerToHubMessage } from "../types.ts";
import { createAgentNetworkTool } from "./agent-network.ts";
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
		pi.registerTool(createAgentNetworkTool(channel));
		pi.registerTool(createCreateSourceTool(channel));
		pi.registerTool(createDestroySourceTool(channel));
		pi.registerTool(createSubscribeSourceTool(channel));
		pi.registerTool(createUnsubscribeSourceTool(channel));
		pi.registerTool(createListSourcesTool(channel));

		// Worker only: /sources command
		pi.registerCommand("sources", {
			description: "List all registered sources",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const raw = await channel.listSources();
					const result = raw as { sources?: SourceInfo[]; error?: string };
					if (result.error) {
						ctx.ui.notify(`Failed to list sources: ${result.error}`, "error");
						return;
					}
					const sources = result.sources ?? [];
					if (sources.length === 0) {
						ctx.ui.notify("No sources registered. Use create_source tool to register one.", "info");
						return;
					}
					const lines = sources.map(
						(s) => `  ${s.name} [${s.status}] command="${s.command}" subscribers=${s.subscriberCount}`,
					);
					ctx.ui.notify(`Sources:\n${lines.join("\n")}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to list sources: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});

		// Worker only: handle incoming messages through the extension event bus
		let isAgentRunning = false;
		pi.on("agent_start", () => {
			isAgentRunning = true;
		});
		pi.on("agent_end", () => {
			isAgentRunning = false;
		});
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

		channel.onIncomingMessage((content, sourceName) => {
			if (sourceName) {
				process.stderr.write(`[d-pi extension] Received source message from "${sourceName}"\n`);
			}
			const metaContent = extractMeta(content)
				? content
				: injectMeta(content, sourceName ? "source" : "connect", undefined, sourceName);
			const extracted = extractMeta(metaContent);
			const options = isAgentRunning ? { deliverAs: "followUp" as const } : { triggerTurn: true };
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

		// Client only: /agents command
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the network",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const response = await fetch(`${config.hubUrl}/_hub/network`);
					if (!response.ok) {
						ctx.ui.notify(`Failed to fetch agent network: ${response.status}`, "error");
						return;
					}
					const network = (await response.json()) as AgentNetworkSnapshot;

					if (network.agents.length === 0) {
						ctx.ui.notify("No agents in network", "info");
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

		// Build meta label: sourceType[:name] · authName · timeString
		let source: string = meta.sourceType;
		if (meta.sourceName) source = `${source}:${meta.sourceName}`;
		else if (meta.agentId) source = `${source}:${meta.agentId}`;
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
function formatAgentEntry(agent: AgentNetworkEntry, depth: number, isLast: boolean, isCurrent: boolean): string {
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
