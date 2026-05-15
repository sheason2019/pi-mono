import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { defineTool } from "@sheason/pi-coding-agent";
import { Type } from "typebox";
import type { HubAgentAdapter } from "../agent/hub-agent-adapter.js";

export interface ReloadConfigToolHost {
	agentId: string;
	getAdapter(): HubAgentAdapter | undefined;
}

export function createReloadConfigToolDefinition(host: ReloadConfigToolHost): ToolDefinition {
	return defineTool({
		name: "reload_config",
		label: "reload_config",
		description:
			"Reload this hub agent's configuration after editing Pi config files. Refreshes models, settings, MCP, sources, skills, prompts, and available tools for the current agent instance.",
		promptSnippet: "Reload this agent's Pi configuration after changing config files.",
		promptGuidelines: [
			"Call reload_config after editing Pi configuration files that should affect this running hub agent.",
			"Use this before trying newly configured models, MCP servers, skills, prompts, sources, or settings.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const adapter = host.getAdapter();
			if (!adapter) {
				throw new Error(`Hub agent adapter is not initialized for agent ${host.agentId}.`);
			}
			await adapter.reload();
			const text = `Reloaded configuration for hub agent ${host.agentId}.`;
			return { content: [{ type: "text" as const, text }], details: { agentId: host.agentId } };
		},
	});
}
