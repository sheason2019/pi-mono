import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@sheason/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createTeamTool(channel: HubChannel) {
	return defineTool({
		name: "team",
		label: "Team",
		description:
			"List the current team snapshot — agents, their parent/child relationships, roles, and connection status. Use agent **names** (not IDs) when calling destroy_agent or send_message.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const snapshot = await channel.getTeam();
				const agentLines = snapshot.agents.map((a) => {
					const depth = getDepth(snapshot, a.name);
					const indent = "  ".repeat(depth);
					const children = a.children.length > 0 ? ` → [${a.children.join(", ")}]` : "";
					return `${indent}${a.name} [${a.status}]${children}`;
				});
				const executorLines = snapshot.executors.map((e) => {
					const status = e.attached ? "attached" : "registered";
					return `${e.connectId} [${status}] cwd=${e.cwd} bound=${e.boundAgentName ?? "(none)"}`;
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Team:\nAgents:\n${agentLines.join("\n")}\n\nExecutors:\n${executorLines.length > 0 ? executorLines.join("\n") : "(none)"}\n\nUse agent names (e.g. "${snapshot.agents.find((a) => a.name === "root")?.name}") for destroy_agent and send_message.`,
						},
					],
					details: { agents: snapshot.agents, executors: snapshot.executors },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get team: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}

function getDepth(snapshot: { agents: Array<{ name: string; parentName?: string }> }, agentName: string): number {
	const agentMap = new Map(snapshot.agents.map((a) => [a.name, a]));
	let depth = 0;
	let current = agentMap.get(agentName);
	while (current?.parentName) {
		depth++;
		current = agentMap.get(current.parentName);
	}
	return depth;
}
