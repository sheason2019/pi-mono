import { Type } from "typebox";
import type {
	DPiCreateAgentActionPayload,
	DPiHubActionsClient,
	DPiHubMessageMode,
	DPiTeamSnapshot,
} from "./hub-actions.ts";
import type { DPiTool, DPiToolDetails } from "./tool-surface.ts";
import { defineDPiTool, dPiToolJsonDetails, dPiToolTextResult } from "./tool-surface.ts";

export interface DPiSendMessageToolOptions {
	agentName: string;
}

export function createDPiSendMessageTool(client: DPiHubActionsClient, options: DPiSendMessageToolOptions): DPiTool {
	return defineDPiTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to another agent in the network. The target agent will receive the message as input. This is asynchronous - the tool returns immediately and does not wait for a reply. Use mode='steer' to interrupt the target's current turn; the default mode='next' queues the message at the start of the target's next turn.",
		parameters: Type.Object({
			agent_name: Type.String({ description: "Name of the target agent" }),
			message: Type.String({ description: "Message content to send" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("next"), Type.Literal("steer")], {
					description:
						"Routing mode. 'next' (default) queues at the start of the target's next turn; 'steer' interrupts the current turn. Same vocabulary as the TUI's Enter / Ctrl+Enter.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const targetAgentName = params.agent_name?.trim();
				if (!targetAgentName) {
					return errorTextResult("Failed to send message: agent_name is required");
				}
				const mode: DPiHubMessageMode = params.mode ?? "next";
				const result = await client.sendMessage({
					fromAgentName: options.agentName,
					toAgentName: targetAgentName,
					content: params.message,
					mode,
				});
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to send message: ${actionError}`);
				}
				return dPiToolTextResult(
					`Message sent to agent ${targetAgentName} (mode=${mode}). Result: ${JSON.stringify(result)}`,
				);
			} catch (err) {
				return errorTextResult(`Failed to send message: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiCreateAgentTool(client: DPiHubActionsClient): DPiTool {
	return defineDPiTool({
		name: "create_agent",
		label: "Create Agent",
		description:
			"Create a new child agent in the network. The new agent will be a direct child of this agent (the caller) and will have its own independent session. You cannot specify the parent - the parent is always the agent that called this tool. The agent tree is enforced as a strict parent/child topology: each new agent becomes a direct child of the caller, never a sibling, never a grandchild, never an orphan.",
		parameters: Type.Object({
			name: Type.String({ description: "Human-readable name for the new agent" }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory override (defaults to workspace/agents/<name>/)" }),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const payload: DPiCreateAgentActionPayload = {
					name: params.name,
					cwd: params.cwd,
				};
				const result = await client.createAgent(payload);
				return dPiToolTextResult(
					`Created agent "${result.agentName}"`,
					dPiToolJsonDetails({ agentName: result.agentName }),
				);
			} catch (err) {
				return errorTextResult(`Failed to create agent: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiDestroyAgentTool(client: DPiHubActionsClient): DPiTool {
	return defineDPiTool({
		name: "destroy_agent",
		label: "Destroy Agent",
		description:
			"Destroy an agent in the network. The agent must have no children and must not be the creator of any active source. Unsubscribe from all sources and destroy all child agents first.",
		parameters: Type.Object({
			agent_name: Type.String({ description: "Name of the agent to destroy" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await client.destroyAgent({ agentName: params.agent_name });
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to destroy agent: ${actionError}`);
				}
				return dPiToolTextResult(`Agent "${params.agent_name}" destroyed`);
			} catch (err) {
				return errorTextResult(`Failed to destroy agent: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiTeamTool(client: DPiHubActionsClient): DPiTool {
	return defineDPiTool({
		name: "team",
		label: "Team",
		description:
			"List the current team snapshot - agents, their parent/child relationships, roles, and connection status. Use agent names when calling destroy_agent or send_message.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const snapshot = await client.getTeam();
				const agentLines = snapshot.agents.map((agent) => {
					const depth = getDepth(snapshot, agent.name);
					const indent = "  ".repeat(depth);
					const children = agent.children.length > 0 ? ` -> [${agent.children.join(", ")}]` : "";
					return `${indent}${agent.name} [${agent.status}]${children}`;
				});
				const executorLines = snapshot.executors.map((executor) => {
					const status = executor.attached ? "attached" : "registered";
					return `${executor.connectId} [${status}] cwd=${executor.cwd} bound=${executor.boundAgentName ?? "(none)"}`;
				});
				const rootName = snapshot.agents.find((agent) => agent.name === "root")?.name;
				const text = `Team:\nAgents:\n${agentLines.join("\n")}\n\nExecutors:\n${executorLines.length > 0 ? executorLines.join("\n") : "(none)"}\n\nUse agent names (e.g. "${rootName}") for destroy_agent and send_message.`;
				return dPiToolTextResult(text, teamDetails(snapshot));
			} catch (err) {
				return errorTextResult(`Failed to get team: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiOrchestrationTools(
	client: DPiHubActionsClient,
	options: DPiSendMessageToolOptions,
): DPiTool[] {
	return [
		createDPiSendMessageTool(client, options),
		createDPiCreateAgentTool(client),
		createDPiDestroyAgentTool(client),
		createDPiTeamTool(client),
	];
}

function errorTextResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		isError: true,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function okActionError(result: { ok: boolean; error?: string }): string | undefined {
	if (result.error) {
		return result.error;
	}
	return result.ok ? undefined : "action returned ok=false";
}

function getDepth(snapshot: { agents: Array<{ name: string; parentName?: string }> }, agentName: string): number {
	const agentMap = new Map(snapshot.agents.map((agent) => [agent.name, agent]));
	let depth = 0;
	let current = agentMap.get(agentName);
	while (current?.parentName) {
		depth++;
		current = agentMap.get(current.parentName);
	}
	return depth;
}

function teamDetails(snapshot: DPiTeamSnapshot): DPiToolDetails {
	return dPiToolJsonDetails({ agents: snapshot.agents, executors: snapshot.executors });
}
