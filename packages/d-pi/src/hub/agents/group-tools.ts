import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const groupSchema = Type.Object({}, { additionalProperties: false });

const updateAgentDescriptionSchema = Type.Object(
	{
		agentId: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Target child agent id. Child agents may omit this to update their own description.",
			}),
		),
		description: Type.String({
			description: "Concise summary of this child agent's role, current responsibilities, and useful capabilities.",
		}),
	},
	{ additionalProperties: false },
);

export type GroupToolInput = Static<typeof groupSchema>;
export type UpdateAgentDescriptionToolInput = Static<typeof updateAgentDescriptionSchema>;

export interface GroupToolHost {
	groupText(callerAgentId: string): Promise<string>;
	updateAgentDescriptionText(callerAgentId: string, input: UpdateAgentDescriptionToolInput): Promise<string>;
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
