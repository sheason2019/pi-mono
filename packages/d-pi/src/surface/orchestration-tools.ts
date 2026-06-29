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
			"Show a detailed snapshot of the running team: each agent's runtime status, model, sources, tools, commands, and context files; all workspace sources with their running state and subscribers; and connected executors. Use agent names when calling destroy_agent or send_message.",
		parameters: Type.Object({}),
		async execute() {
			const ctx = getBuiltinContext();
			try {
				const snapshot = await ctx.hubClient.getTeam();
				const lines: string[] = [];

				lines.push(`Agents (${snapshot.agents.length}):`);
				const agentMap = new Map(snapshot.agents.map((a) => [a.name, a]));

				function getDepth(name: string, visited = new Set<string>()): number {
					if (visited.has(name)) return 0;
					visited.add(name);
					const agent = agentMap.get(name);
					if (!agent?.parentName) return 0;
					return 1 + getDepth(agent.parentName, visited);
				}

				const sorted = [...snapshot.agents].sort((a, b) => {
					const da = getDepth(a.name);
					const db = getDepth(b.name);
					if (da !== db) return da - db;
					return a.name.localeCompare(b.name);
				});

				for (const agent of sorted) {
					const depth = getDepth(agent.name);
					const indent = "  ".repeat(depth);
					const statusTag = agent.error ? `[error:${agent.error}]` : `[${agent.status}]`;
					const treePrefix = depth === 0 ? "" : "-> ";
					lines.push(`${indent}${treePrefix}${agent.name} ${statusTag}`);

					const sources = agent.sources ?? [];
					const toolCount = agent.toolCount ?? 0;
					const customToolCount = agent.customToolCount ?? 0;
					const commandCount = agent.commandCount ?? 0;
					const contextFileCount = agent.contextFileCount ?? 0;
					const disableDefaults = agent.disableDefaultTools ?? false;

					const details: string[] = [];
					if (agent.description) details.push(`desc: ${agent.description}`);
					if (agent.model) details.push(`model: ${agent.model}`);
					else details.push("model: (unset)");

					const parts: string[] = [];
					parts.push(`tools:${toolCount}${disableDefaults ? " (no defaults)" : ""}`);
					if (customToolCount > 0) parts.push(`${customToolCount} custom`);
					if (commandCount > 0) parts.push(`cmds:${commandCount}`);
					if (contextFileCount > 0) parts.push(`ctx:${contextFileCount}`);
					if (agent.hasSkillsDir) parts.push("skills/");
					if (agent.hasToolsDir) parts.push("tools/");
					if (agent.hasCommandsDir) parts.push("cmds/");
					details.push(parts.join(", "));

					if (sources.length > 0) {
						details.push(`sources: ${sources.join(", ")}`);
					} else {
						details.push("sources: (none)");
					}

					for (const d of details) {
						lines.push(`${indent}    ${d}`);
					}
				}

				lines.push("");
				if (snapshot.sources.length > 0) {
					lines.push(`Sources (${snapshot.sources.length}):`);
					for (const src of snapshot.sources) {
						const state = src.running ? "running" : "stopped";
						const subs =
							src.subscribers.length > 0 ? `subscribers: ${src.subscribers.join(", ")}` : "no subscribers";
						const msgs = src.messageCount > 0 ? `${src.messageCount} msgs` : "no msgs yet";
						const lastMsg = src.lastMessageTime ? formatTimeAgo(src.lastMessageTime) : "never";
						lines.push(`  ${src.name} [${state}] cmd: ${src.command}`);
						lines.push(`    path: ${src.filePath}`);
						lines.push(`    ${subs}; ${msgs}; last: ${lastMsg}`);
					}
				} else {
					lines.push("Sources: (none)");
				}

				lines.push("");
				if (snapshot.executors.length > 0) {
					lines.push(`Executors (${snapshot.executors.length}):`);
					for (const exec of snapshot.executors) {
						const state = exec.attached ? "attached" : "registered";
						const bound = exec.boundAgentName ? `bound to: ${exec.boundAgentName}` : "unbound";
						lines.push(`  ${exec.connectId} [${state}] cwd=${exec.cwd} ${bound}`);
					}
				} else {
					lines.push("Executors: (none)");
				}

				return toolTextResult(lines.join("\n"), teamDetails(snapshot));
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
			await reloadFn(params.reason);
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

export function createPlanTool(): AgentToolDefinition {
	return defineTool({
		name: "plan",
		label: "Plan",
		description:
			"Update your visible task plan (TODO list) displayed above the user's input box. " +
			"Call this at the START of your turn to outline your plan before taking action, " +
			"and update it as you complete tasks. The plan is visible to the user in real-time. " +
			"Pass the COMPLETE list of todos each time you call this (it replaces the previous plan). " +
			"Use concise, action-oriented titles for each item, and provide a brief description " +
			"explaining the goal or current state of the task so the user can understand the purpose at a glance.",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					id: Type.String({
						description:
							"Short unique identifier for this todo item (e.g. 't1', 'investigate', 'implement'). " +
							"Reuse the same id when updating an item's status.",
					}),
					title: Type.String({ description: "Concise task title (1 short action phrase)." }),
					description: Type.Optional(
						Type.String({
							description:
								"Optional brief explanation of the task's goal, approach, or current findings. " +
								"Shown under the title to help the user understand why this step is needed.",
						}),
					),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
						description: "Current status of the task.",
					}),
				}),
				{ description: "Complete ordered list of todo items. Replaces the previous plan entirely." },
			),
		}),
		async execute(_toolCallId, params) {
			const ctx = getBuiltinContext();
			const plan = params.todos.map((t) => ({
				id: t.id,
				title: t.title,
				description: t.description,
				status: t.status,
			}));
			ctx.updatePlan(plan);
			const completed = plan.filter((t) => t.status === "completed").length;
			const inProgress = plan.filter((t) => t.status === "in_progress").length;
			const pending = plan.filter((t) => t.status === "pending").length;
			const lines = plan.map((t) => {
				const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
				return `${marker} ${t.title}`;
			});
			return toolTextResult(
				`Plan updated (${completed} done, ${inProgress} in progress, ${pending} pending):\n${lines.join("\n")}`,
			);
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

function teamDetails(snapshot: DPiTeamSnapshot) {
	return toolJsonDetails({ agents: snapshot.agents, sources: snapshot.sources, executors: snapshot.executors });
}

function formatTimeAgo(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 1000) return "just now";
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}
