import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentNetworkEntry, AgentNetworkSnapshot, AgentStatus } from "../types.ts";

/** File where the selected agent ID is written before triggering shutdown.
 *  The parent process checks for this file to determine if the child exited
 *  due to an agent switch (file exists) or a normal quit (file absent). */
export const AGENT_SWITCH_FILE = join(tmpdir(), "d-pi-agent-switch.txt");

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

/** Format a single agent entry for the selector.
 *  Uses ├ for intermediate children and └ for the last child.
 *  Tab + agentId is appended for reliable parsing. */
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

/**
 * Create the d-pi client-side extension factory for connect mode.
 *
 * Registers the `/agents` command which shows a tree-structured selector
 * with status indicators, model names, and current agent highlighting.
 * Uses ctx.ui.select() and triggers graceful shutdown via ctx.shutdown().
 */
export function createDPiClientExtensionFactory(hubUrl: string, currentAgentId?: string): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the network",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const response = await fetch(`${hubUrl}/_hub/network`);
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
						options.push(formatAgentEntry(agent, depth, isLast, agent.id === currentAgentId));
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
							options.push(formatAgentEntry(agent, 0, true, agent.id === currentAgentId));
						}
					}

					const title = `Switch to agent (${network.agents.length} agent${network.agents.length !== 1 ? "s" : ""})`;
					const selected = await ctx.ui.select(title, options);
					if (!selected) return;

					// Extract agent ID from the tab-separated suffix
					const agentId = parseAgentId(selected);
					if (!agentId) return;

					// Write selected agent ID to temp file, then trigger graceful shutdown
					// (which restores terminal state) instead of raw process.exit()
					writeFileSync(AGENT_SWITCH_FILE, agentId, "utf-8");
					ctx.shutdown();
				} catch (err) {
					ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};
}
