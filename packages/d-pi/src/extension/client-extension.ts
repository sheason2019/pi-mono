import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentNetworkSnapshot } from "../types.ts";

/** File where the selected agent ID is written before triggering shutdown.
 *  The parent process checks for this file to determine if the child exited
 *  due to an agent switch (file exists) or a normal quit (file absent). */
export const AGENT_SWITCH_FILE = join(tmpdir(), "d-pi-agent-switch.txt");

/**
 * Create the d-pi client-side extension factory for connect mode.
 *
 * Registers the `/agents` command which shows a tree-structured selector
 * using ctx.ui.select() and triggers a graceful shutdown via ctx.shutdown()
 * so the terminal is properly restored. The parent process detects the switch
 * by checking for the AGENT_SWITCH_FILE.
 */
export function createDPiClientExtensionFactory(hubUrl: string): ExtensionFactory {
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

					const walkTree = (agentId: string, depth: number): void => {
						const agent = agentMap.get(agentId);
						if (!agent) return;
						const indent = depth > 0 ? `${"│ ".repeat(depth - 1)}└ ` : "";
						options.push(`${indent}${agent.name}`);
						for (const childId of agent.children) {
							walkTree(childId, depth + 1);
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
							options.push(`${agent.name}`);
						}
					}

					const selected = await ctx.ui.select("Switch to agent", options);
					if (!selected) return;

					// Resolve the selected name back to an agent
					const displayName = selected.replace(/^[│└\s]+/, "");
					const agent = network.agents.find((a) => a.name === displayName);
					if (!agent) return;

					// Write selected agent ID to temp file, then trigger graceful shutdown
					// (which restores terminal state) instead of raw process.exit()
					writeFileSync(AGENT_SWITCH_FILE, agent.id, "utf-8");
					ctx.shutdown();
				} catch (err) {
					ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};
}
