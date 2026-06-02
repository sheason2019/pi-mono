import { Type } from "@sheason/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createAgentNetworkTool(channel: HubChannel) {
	return defineTool({
		name: "agent_network",
		label: "Agent Network",
		description:
			"Get the current agent network topology. Returns a snapshot of all agents, their parent-child relationships, and their statuses. Use agent **names** (not IDs) when calling destroy_agent or send_message.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const snapshot = await channel.getNetwork();
				const lines = snapshot.agents.map((a) => {
					const depth = getDepth(snapshot, a.id);
					const indent = "  ".repeat(depth);
					const children = a.children.length > 0 ? ` → [${a.children.join(", ")}]` : "";
					return `${indent}${a.name} [${a.status}]${children}`;
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent Network:\n${lines.join("\n")}\n\nUse agent names (e.g. "${snapshot.agents.find((a) => a.name === "root")?.name}") for destroy_agent and send_message.`,
						},
					],
					details: { agents: snapshot.agents },
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
