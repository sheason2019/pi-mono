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
				Type.String({ description: "Working directory override (defaults to workspace/agents/<name>/)" }),
			),
			model: Type.Optional(
				Type.String({ description: "Model to use for the new agent (e.g. 'anthropic/claude-sonnet-4')" }),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Allowlist of tool names. When provided, only these tools are exposed to the agent.",
				}),
			),
			excludeTools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Denylist of tool names. These tools will not be exposed to the agent.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const raw = await channel.createAgent(
					params.name,
					params.cwd,
					params.model,
					params.tools,
					params.excludeTools,
				);
				const result = raw as { agentId?: string; name?: string; error?: string };
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: `Failed to create agent: ${result.error}` }],
						details: {},
						isError: true,
					};
				}
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
