import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { defineTool } from "@sheason/pi-coding-agent";
import { type Static, Type } from "typebox";

const groupSchema = Type.Object({}, { additionalProperties: false });

const updateAgentDescriptionSchema = Type.Object(
	{
		agentId: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Target agent id. Omit to update self.",
			}),
		),
		description: Type.String({
			description: "Role, responsibilities, and capabilities.",
		}),
	},
	{ additionalProperties: false },
);

const updateAgentSummarySchema = Type.Object(
	{
		summary: Type.String({
			description: "Short-lived work summary. Clear when idle.",
		}),
	},
	{ additionalProperties: false },
);

export type GroupToolInput = Static<typeof groupSchema>;
export type UpdateAgentDescriptionToolInput = Static<typeof updateAgentDescriptionSchema>;
export type UpdateAgentSummaryToolInput = Static<typeof updateAgentSummarySchema>;

export interface GroupToolHost {
	groupText(callerAgentId: string): Promise<string>;
	updateAgentDescriptionText(callerAgentId: string, input: UpdateAgentDescriptionToolInput): Promise<string>;
	updateAgentSummaryText(callerAgentId: string, input: UpdateAgentSummaryToolInput): Promise<string>;
}

export function createGroupToolDefinitions(getHost: () => GroupToolHost, callerAgentId: string): ToolDefinition[] {
	return [
		defineTool({
			name: "group",
			label: "group",
			description:
				"Show your hub group identity, all main/child agents, available tool executors, and field notes. peerCount is only the number of connected d-pi peer clients for an agent; it is not agent availability or working state.",
			promptSnippet: "Inspect the current multi-agent group before delegating work or choosing an executor.",
			promptGuidelines: [
				"Use group to discover child agents, their responsibilities, and which peers/executors are available. Do not treat peerCount=0 as offline; use status/isWorking for agent state. Browser Web UI connections are host UIs, not peer executors, so they are not counted in peerCount.",
				'Use peer-id "host" for tools that should run on the D-Pi hub host workspace.',
				"Use send_message_to_agent or broadcast_message_to_agents for inter-agent communication.",
			],
			parameters: groupSchema,
			async execute() {
				const text = await getHost().groupText(callerAgentId);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "update_agent_summary",
			label: "update_agent_summary",
			description:
				"Update your own current work summary so other agents can decide whether to send urgent messages with flush=true. During batch work, use this as a progress field. This is short-lived status, not long-term capability description.",
			promptSnippet:
				"Keep update_agent_summary current while working; for batch tasks, use it as a concise progress field.",
			promptGuidelines: [
				"Call update_agent_summary when starting meaningful work, when switching focus, and when making progress through a batch.",
				'For batch work, write progress such as "processing 3/12: validating socket fanout tests" so other agents can decide whether an urgent message should interrupt with flush=true.',
				"Clear the summary with an empty string when you are idle or the work is complete.",
			],
			parameters: updateAgentSummarySchema,
			async execute(_id, params) {
				const text = await getHost().updateAgentSummaryText(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "update_agent_description",
			label: "update_agent_description",
			description:
				"Update a child agent description for capability discovery. Main can update children; a child can update only itself. Main description is not editable through this tool.",
			parameters: updateAgentDescriptionSchema,
			async execute(_id, params) {
				const text = await getHost().updateAgentDescriptionText(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
	];
}
