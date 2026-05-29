import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HubChannel } from "./hub-channel.ts";

export function createCreateAgentTool(channel: HubChannel) {
	return defineTool({
		name: "create_agent",
		label: "Create Agent",
		description:
			"Create a new child agent in the network. The new agent will be a descendant of this agent and will have its own independent session.",
		parameters: Type.Object({
			name: Type.String({ description: "Human-readable name for the new agent" }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the new agent (defaults to this agent's cwd)" }),
			),
			model: Type.Optional(
				Type.String({ description: "Model to use for the new agent (e.g. 'anthropic/claude-sonnet-4')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = (await channel.createAgent(params.name, params.cwd, params.model)) as {
					agentId: string;
					name: string;
				};
				return {
					content: [{ type: "text" as const, text: `Created agent "${result.name}" (ID: ${result.agentId})` }],
					details: { agentId: result.agentId },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to create agent: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
