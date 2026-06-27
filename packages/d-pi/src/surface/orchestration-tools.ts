import { Type } from "typebox";
import type { AgentToolDefinition } from "../agent-definition.ts";
import { defineTool } from "../agent-definition.ts";
import { getBuiltinContext } from "./builtin-context.ts";
import type { DPiCreateAgentActionPayload, DPiHubMessageMode, DPiTeamSnapshot } from "./hub-actions.ts";
import { toolJsonDetails, toolTextResult } from "./tool-surface.ts";

export function createSendMessageTool(): AgentToolDefinition {
	return defineTool({
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
			const ctx = getBuiltinContext();
			try {
				const targetAgentName = params.agent_name?.trim();
				if (!targetAgentName) {
					return errorTextResult("Failed to send message: agent_name is required");
				}
				const mode: DPiHubMessageMode = params.mode ?? "next";
				const result = await ctx.hubClient.sendMessage({
					fromAgentName: ctx.agentName,
					toAgentName: targetAgentName,
					content: params.message,
					mode,
				});
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to send message: ${actionError}`);
				}
				return toolTextResult(
					`Message sent to agent ${targetAgentName} (mode=${mode}). Result: ${JSON.stringify(result)}`,
				);
			} catch (err) {
				return errorTextResult(`Failed to send message: ${errorMessage(err)}`);
			}
		},
	});
}

export function createCreateAgentTool(): AgentToolDefinition {
	return defineTool({
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
			const ctx = getBuiltinContext();
			try {
				const payload: DPiCreateAgentActionPayload = {
					name: params.name,
					cwd: params.cwd,
				};
				const result = await ctx.hubClient.createAgent(payload);
				return toolTextResult(
					`Created agent "${result.agentName}"`,
					toolJsonDetails({ agentName: result.agentName }),
				);
			} catch (err) {
				return errorTextResult(`Failed to create agent: ${errorMessage(err)}`);
			}
		},
	});
}

export function createDestroyAgentTool(): AgentToolDefinition {
	return defineTool({
		name: "destroy_agent",
		label: "Destroy Agent",
		description: "Destroy an agent in the network. The agent must have no children. Destroy all child agents first.",
		parameters: Type.Object({
			agent_name: Type.String({ description: "Name of the agent to destroy" }),
		}),
		async execute(_toolCallId, params) {
			const ctx = getBuiltinContext();
			try {
				const result = await ctx.hubClient.destroyAgent({ agentName: params.agent_name });
				const actionError = okActionError(result);
				if (actionError) {
					return errorTextResult(`Failed to destroy agent: ${actionError}`);
				}
				return toolTextResult(`Agent "${params.agent_name}" destroyed`);
			} catch (err) {
				return errorTextResult(`Failed to destroy agent: ${errorMessage(err)}`);
			}
		},
	});
}

export function createTeamTool(): AgentToolDefinition {
	return defineTool({
		name: "team",
		label: "Team",
		description:
			"List the current team snapshot - agents, their parent/child relationships, and connection status. Use agent names when calling destroy_agent or send_message.",
		parameters: Type.Object({}),
		async execute() {
			const ctx = getBuiltinContext();
			try {
				const snapshot = await ctx.hubClient.getTeam();
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
				return toolTextResult(text, teamDetails(snapshot));
			} catch (err) {
				return errorTextResult(`Failed to get team: ${errorMessage(err)}`);
			}
		},
	});
}

export function createReloadTool(): AgentToolDefinition {
	return defineTool({
		name: "reload",
		label: "Reload",
		description:
			"Reload the agent's configuration from agent.ts. Use this after editing agent.ts to apply changes to the model, tools, commands, or system prompt. The reload takes effect immediately for the next LLM call.",
		parameters: Type.Object({
			reason: Type.Optional(
				Type.String({
					description: "Optional reason for the reload. Explain what changed or why reload is needed.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const ctx = getBuiltinContext();
			const reloadFn = ctx.getReloadFn();
			if (!reloadFn) {
				throw new Error("Reload not available: d-pi session is not initialized yet.");
			}
			const input = params as { reason?: unknown };
			await reloadFn(typeof input.reason === "string" ? input.reason : undefined);
			return {
				content: [{ type: "text" as const, text: "Agent configuration reloaded." }],
				details: ctx.getReloadDetails(),
			};
		},
	});
}

export function createReloadWorkspaceTool(): AgentToolDefinition {
	return defineTool({
		name: "reload_workspace",
		label: "Reload Workspace",
		description:
			"Reload workspace-level resources: models/, context/*.md, sources/, and skills/. This re-scans the workspace directories and restarts any changed source processes. It does NOT reload any agent's configuration or context - each agent must call 'reload' individually to pick up new workspace context, models, or skills.",
		parameters: Type.Object({}),
		async execute() {
			const ctx = getBuiltinContext();
			try {
				const result = await ctx.hubClient.reloadWorkspace();
				const lines: string[] = ["Workspace resources reloaded."];
				if (result.models.length > 0) {
					lines.push(`Models (${result.models.length}): ${result.models.join(", ")}`);
				} else {
					lines.push("Models: (none)");
				}
				if (result.contextFiles.length > 0) {
					lines.push(`Context files (${result.contextFiles.length}): ${result.contextFiles.join(", ")}`);
				} else {
					lines.push("Context files: (none)");
				}
				lines.push(
					`Sources: ${result.sources.total} total${result.sources.added.length > 0 ? `, ${result.sources.added.length} added (${result.sources.added.join(", ")})` : ""}${result.sources.changed.length > 0 ? `, ${result.sources.changed.length} changed (${result.sources.changed.join(", ")})` : ""}${result.sources.removed.length > 0 ? `, ${result.sources.removed.length} removed (${result.sources.removed.join(", ")})` : ""}`,
				);
				lines.push("Note: Agents must call 'reload' to pick up new workspace context or models.");
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: toolJsonDetails(result),
				};
			} catch (err) {
				return errorTextResult(`Failed to reload workspace: ${errorMessage(err)}`);
			}
		},
	});
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

function teamDetails(snapshot: DPiTeamSnapshot) {
	return toolJsonDetails({ agents: snapshot.agents, executors: snapshot.executors });
}
