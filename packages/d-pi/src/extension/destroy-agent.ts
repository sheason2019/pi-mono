import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createDestroyAgentTool(channel: HubChannel) {
	return defineTool({
		name: "destroy_agent",
		label: "Destroy Agent",
		description:
			"Destroy an agent in the network. The agent and all its descendants will be terminated. This action is irreversible.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "ID or name of the agent to destroy" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.destroyAgent(params.agent_id);
				const result = raw as { ok?: boolean; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to destroy agent: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Agent "${params.agent_id}" destroyed` }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to destroy agent: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
