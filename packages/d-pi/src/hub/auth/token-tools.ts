import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const createAgentTokenSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, description: "Human-readable token name." }),
		description: Type.String({
			minLength: 1,
			description: "Short purpose and audience description for this token.",
		}),
		user: Type.String({
			minLength: 1,
			description: "Real user, guest, service, or audience that will use this token.",
		}),
		purpose: Type.String({
			minLength: 1,
			description: "Concrete reason this user or audience needs access.",
		}),
		scopeMode: Type.Optional(
			Type.Union(
				[Type.Literal("subtree"), Type.Literal("self"), Type.Literal("direct_children"), Type.Literal("explicit")],
				{
					description:
						"Optional token scope mode. Defaults to subtree for this agent. Use self for a single guest agent token.",
				},
			),
		),
		scopeAgentId: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Scope root agent id. Defaults to the calling agent id.",
			}),
		),
		agentIds: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description: 'Allowed agent ids when scopeMode is "explicit".',
			}),
		),
	},
	{ additionalProperties: false },
);

const revokeAgentTokenSchema = Type.Object(
	{
		tokenId: Type.String({ minLength: 1, description: "Token id returned by create_agent_token." }),
	},
	{ additionalProperties: false },
);

export type CreateAgentTokenToolInput = Static<typeof createAgentTokenSchema>;
export type RevokeAgentTokenToolInput = Static<typeof revokeAgentTokenSchema>;

export interface AgentTokenToolHost {
	createAgentTokenText(callerAgentId: string, input: CreateAgentTokenToolInput): Promise<string>;
	revokeAgentTokenText(callerAgentId: string, input: RevokeAgentTokenToolInput): Promise<string>;
}

export function createAgentTokenToolDefinitions(
	getHost: () => AgentTokenToolHost,
	callerAgentId: string,
): ToolDefinition[] {
	return [
		defineTool({
			name: "create_agent_token",
			label: "create_agent_token",
			description:
				"Create a named access token scoped to this agent or an allowed descendant scope. Always identify the real user or audience and access purpose. The plaintext token is returned once and persisted in the hub auth registry.",
			parameters: createAgentTokenSchema,
			async execute(_id, params) {
				const text = await getHost().createAgentTokenText(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "revoke_agent_token",
			label: "revoke_agent_token",
			description:
				"Revoke a non-root access token scoped to this agent or one of its descendants. Connected peers using the token are disconnected immediately.",
			parameters: revokeAgentTokenSchema,
			async execute(_id, params) {
				const text = await getHost().revokeAgentTokenText(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
	];
}
