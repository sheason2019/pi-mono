import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createAgentNetworkTool(channel: HubChannel) {
	return defineTool({
		name: "agent_network",
		label: "Agent Network",
		description:
			"Get the current agent network topology. Returns a snapshot of all agents, their parent-child relationships, and their statuses.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const snapshot = await channel.getNetwork();
				const lines = snapshot.agents.map((a) => {
					const depth = getDepth(snapshot, a.id);
					const indent = "  ".repeat(depth);
					const children = a.children.length > 0 ? ` → [${a.children.join(", ")}]` : "";
					return `${indent}${a.name} (${a.id.slice(0, 8)}...) [${a.status}]${children}`;
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent Network (root: ${snapshot.rootId.slice(0, 8)}...):\n${lines.join("\n")}`,
						},
					],
					details: { agents: snapshot.agents.length },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get network: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}

function getDepth(snapshot: { agents: Array<{ id: string; parentId?: string }> }, agentId: string): number {
	const agentMap = new Map(snapshot.agents.map((a) => [a.id, a]));
	let depth = 0;
	let current = agentMap.get(agentId);
	while (current?.parentId) {
		depth++;
		current = agentMap.get(current.parentId);
	}
	return depth;
}
