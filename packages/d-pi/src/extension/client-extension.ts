import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentNetworkSnapshot } from "../types.ts";

/**
 * Create the d-pi client-side extension factory for connect mode.
 *
 * Registers the `/agents` command which shows a tree-structured selector
 * using ctx.ui.select() and switches the connected agent via ctx.switchAgent().
 */
export function createDPiClientExtensionFactory(hubUrl: string): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("agents", {
			description: "Switch to a different agent in the network",
			async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
				if (!ctx.switchAgent) {
					ctx.ui.notify("switchAgent not available in this context", "error");
					return;
				}

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

					await ctx.switchAgent(`${hubUrl}/agents/${agent.id}`, hubUrl);
				} catch (err) {
					ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};
}
