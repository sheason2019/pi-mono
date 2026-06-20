import { Type } from "@earendil-works/pi-ai";
import type {
	DPiCreateAgentActionPayload,
	DPiGetSourceActionResult,
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
			agent_id: Type.Optional(Type.String({ description: "Name of the target agent" })),
			agent_name: Type.Optional(Type.String({ description: "Alias for agent_id" })),
			toAgentName: Type.Optional(Type.String({ description: "Alias for agent_id" })),
			agentIds: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], {
					description:
						"Legacy alias for agent_id; when an array is provided it must contain exactly one agent name",
				}),
			),
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
				const targetAgentName = resolveSendMessageTarget(params);
				if (!targetAgentName) {
					return errorTextResult("Failed to send message: target agent name is required");
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

function resolveSendMessageTarget(params: {
	agent_id?: string;
	agent_name?: string;
	toAgentName?: string;
	agentIds?: string | string[];
}): string | undefined {
	if (params.agent_id?.trim()) return params.agent_id.trim();
	if (params.agent_name?.trim()) return params.agent_name.trim();
	if (params.toAgentName?.trim()) return params.toAgentName.trim();
	if (typeof params.agentIds === "string") return params.agentIds.trim() || undefined;
	if (Array.isArray(params.agentIds) && params.agentIds.length === 1) return params.agentIds[0]?.trim() || undefined;
	return undefined;
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
				const agentIdText = result.agentId === undefined ? "" : ` (agentId=${result.agentId})`;
				const details =
					result.agentId === undefined
						? { agentName: result.agentName }
						: { agentName: result.agentName, agentId: result.agentId };
				return dPiToolTextResult(`Created agent "${result.agentName}"${agentIdText}`, dPiToolJsonDetails(details));
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
			agent_id: Type.String({ description: "ID or name of the agent to destroy" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await client.destroyAgent({ agentName: params.agent_id });
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to destroy agent: ${actionError}`);
				}
				return dPiToolTextResult(`Agent "${params.agent_id}" destroyed`);
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
			"List the current team snapshot - agents, their parent/child relationships, roles, and connection status. Use agent names (not IDs) when calling destroy_agent or send_message.",
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

export function createDPiSetSourceTool(client: DPiHubActionsClient): DPiTool {
	return defineDPiTool({
		name: "set_source",
		label: "Set Source",
		description:
			"Create or update a long-running stdio source by name. The source name is its stable ID: calling set_source again with the same name updates that source instead of creating a duplicate. The command should be a persistent process that continuously produces JSON-RPC 2.0 notifications on stdout; one-shot commands that exit after producing output are not suitable. Subscribers are agent names and replace the source's subscriber list when provided.",
		parameters: Type.Object({
			name: Type.String({ description: "Stable source ID. This is also the source name." }),
			command: Type.String({
				description:
					'Program to run (argv[0]). Must be a long-running process that keeps producing output until deleted. The hub spawns the program with the `args` array as-is - no shell parsing, no globbing, no variable expansion. For shell features, invoke `sh` explicitly: `command: "sh"`, `args: ["-c", "tail -f /var/log/app.log | grep ERROR"]`.',
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: "Positional arguments passed verbatim to the program. Each element is one argv token.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the process" })),
			env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables" })),
			subscribers: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Agent names that should receive output from this source. When provided, this replaces the current subscribers list. When omitted for an existing source, current subscribers are preserved. When omitted for a new source, the calling agent is subscribed.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await client.setSource(params);
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to set source: ${actionError}`);
				}
				return dPiToolTextResult(`Source "${params.name}" set.`);
			} catch (err) {
				return errorTextResult(`Failed to set source: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiGetSourceTool(client: DPiHubActionsClient): DPiTool {
	return defineDPiTool({
		name: "get_source",
		label: "Get Source",
		description:
			"Get one source by name or list all sources. Source names are stable IDs. The returned source info includes subscribers as agent names.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Source ID/name. Omit to list all sources." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await client.getSource({ name: params.name });
				if (result.error) {
					return errorTextResult(`Failed to get source: ${result.error}`);
				}
				return dPiToolTextResult(JSON.stringify(result, null, 2), sourceDetails(result));
			} catch (err) {
				return errorTextResult(`Failed to get source: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDPiDeleteSourceTool(client: DPiHubActionsClient): DPiTool {
	return defineDPiTool({
		name: "delete_source",
		label: "Delete Source",
		description:
			"Delete a source by name. Source names are stable IDs. Deleting a source stops the supervised process, removes its persisted source.json, and clears its subscribers in one operation.",
		parameters: Type.Object({
			name: Type.String({ description: "Source ID/name to delete" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await client.deleteSource({ name: params.name });
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to delete source: ${actionError}`);
				}
				return dPiToolTextResult(`Source "${params.name}" deleted.`);
			} catch (err) {
				return errorTextResult(`Failed to delete source: ${errorMessage(err)}`);
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
		createDPiSetSourceTool(client),
		createDPiGetSourceTool(client),
		createDPiDeleteSourceTool(client),
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

function sourceDetails(result: DPiGetSourceActionResult): DPiToolDetails {
	return dPiToolJsonDetails(result);
}
