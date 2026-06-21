import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, SourceInfo, TeamAgentEntry, TeamSnapshot, WorkerToHubMessage } from "../types.ts";
import type { ExtensionFactory } from "./contracts.ts";
import { HubChannel } from "./hub-channel.ts";

/**
 * Multi-agent / orchestration extension for d-pi.
 *
 * This extension provides the core "multi-agent tree + sources" surface:
 * - Slash commands /agents and /sources (dual registration: no-op stubs on the
 *   server side so they appear in /commands; real interactive handlers on the
 *   client/TUI side)
 * - The worker's HubChannel for orchestration tools.
 *
 * Like the previous monolithic createDPiExtension, this factory supports both
 * "worker" mode (inside a d-pi agent worker thread, talking to the hub over
 * IPC) and "client" mode (inside a connected TUI for /agents /sources UI).
 */

// ── Config types (moved here from the old monolithic index) ──────────────

export interface DPiWorkerConfig {
	mode: "worker";
	/** The agent's name (unique key inside the d-pi workspace). */
	agentName: string;
	postToHub: (message: WorkerToHubMessage) => void;
}

export interface DPiClientConfig {
	mode: "client";
	hubUrl: string;
	/** The name of the agent this client TUI is currently bound to (for highlighting in /agents). */
	currentAgentName?: string;
	/** Bearer token when the hub requires auth. */
	authToken?: string;
}

export type DPiExtensionConfig = DPiWorkerConfig | DPiClientConfig;

/** Temp file used by the client-side /agents handler to request an agent switch. */
export const AGENT_SWITCH_FILE = join(tmpdir(), "d-pi-agent-switch.txt");

/** Map agent status to a visual indicator (used by the /agents selector). */
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

/** Format a single agent entry for the /agents tree selector. */
function formatAgentEntry(agent: TeamAgentEntry, depth: number, isLast: boolean, isCurrent: boolean): string {
	let indent = "";
	if (depth > 0) {
		indent = "\u2502 ".repeat(depth - 1);
		indent += isLast ? "\u2514 " : "\u251C ";
	}
	const indicator = statusIndicator(agent.status);
	const current = isCurrent ? " \u25C0" : "";
	return `${indent}${indicator} ${agent.name}${current}\t${agent.name}`;
}

/** Extract the agent name from a formatted selector line (after the tab). */
function parseAgentName(selected: string): string | undefined {
	const tabIdx = selected.lastIndexOf("\t");
	if (tabIdx === -1) return undefined;
	return selected.slice(tabIdx + 1);
}

// ── Main factory ─────────────────────────────────────────────────────────

/**
 * Create the multi-agent / orchestration extension.
 *
 * This is the main "d-pi as a multi-agent system" behavior:
 * - The /agents and /sources commands (client UI + server stubs)
 * - HubChannel wiring for orchestration tools.
 */
// Overloaded signatures give precise channel presence based on mode at call sites
// (worker always yields a channel; client never does). This removes the need for
// non-null assertions when wiring the remote-executor extension (and in the
// createDPiExtension composer).
export function createMultiAgentExtension(config: DPiWorkerConfig): { factory: ExtensionFactory; channel: HubChannel };
export function createMultiAgentExtension(config: DPiClientConfig): { factory: ExtensionFactory; channel?: undefined };
export function createMultiAgentExtension(config: DPiExtensionConfig): {
	factory: ExtensionFactory;
	channel?: HubChannel;
} {
	if (config.mode === "worker") {
		const channel = new HubChannel(config.agentName, config.postToHub);
		const factory = createMultiAgentWorkerFactory(channel);
		return { factory, channel };
	}
	const factory = createMultiAgentClientFactory(config);
	return { factory };
}

// ── Worker-side implementation ───────────────────────────────────────────

function createMultiAgentWorkerFactory(channel: HubChannel): ExtensionFactory {
	return (pi) => {
		// Server-side command stubs so /sources and /agents appear in the TUI
		// slash menu. Real execution happens in the client extension (synced
		// to the TUI process). This replaces the previous gateway hack that
		// manually injected /agents.
		pi.registerCommand("sources", {
			description: "List all registered sources",
			async handler(_args: string, _ctx): Promise<void> {
				// No-op on the server side; the client extension provides the UI.
			},
		});
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the team",
			async handler(_args: string, _ctx): Promise<void> {
				// No-op on the server side; the client extension provides the UI.
			},
		});
		void channel;
	};
}

// ── Client-side implementation (TUI) ─────────────────────────────────────

function createMultiAgentClientFactory(config: DPiClientConfig): ExtensionFactory {
	return (pi) => {
		// Real /sources command handler (runs in the connected TUI process)
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
						ctx.ui.notify("No sources registered. Use set_source tool to register one.", "info");
						return;
					}
					const options = sources.map(
						(s) => `  ${s.name} [${s.status}] command="${s.command}" subscribers=${s.subscribers.join(",")}`,
					);
					const title = `Sources (${sources.length})`;
					await ctx.ui.select(title, options);
				} catch (err) {
					ctx.ui.notify(`Failed to list sources: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});

		// Real /agents command — tree selector + agent switch via shutdown + flag file
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the team",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const headers: Record<string, string> = {};
					if (config.authToken) {
						headers.Authorization = `Bearer ${config.authToken}`;
					}
					const response = await fetch(`${config.hubUrl}/_hub/team`, { headers });
					if (!response.ok) {
						ctx.ui.notify(`Failed to fetch team: ${response.status}`, "error");
						return;
					}
					const network = (await response.json()) as TeamSnapshot;

					if (network.agents.length === 0) {
						ctx.ui.notify("No agents in team", "info");
						return;
					}

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

					if (network.rootName) {
						walkTree(network.rootName, 0);
					}

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

					const agentName = parseAgentName(selected);
					if (!agentName) return;

					writeFileSync(AGENT_SWITCH_FILE, agentName, "utf-8");
					ctx.shutdown();
				} catch (err) {
					ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};
}

// Re-export the channel type for callers that need the return value of the worker path.
export { HubChannel };
