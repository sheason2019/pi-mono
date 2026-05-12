import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ResourceStatusToolHost {
	resourceStatusText(callerAgentId: string): Promise<string>;
}

export function createResourceStatusToolDefinition(
	getHost: () => ResourceStatusToolHost,
	callerAgentId: string,
): ToolDefinition {
	return defineTool({
		name: "resource_status",
		label: "resource_status",
		description:
			"Inspect this hub agent's configured sources, MCP servers, and skill diagnostics, including startup/config errors that may need maintenance.",
		promptSnippet: "Inspect source, MCP, and skill status before debugging resource failures or after reload_config.",
		promptGuidelines: [
			"Use resource_status when MCP tools, sources, or skills are missing, stopped, or failing.",
			"Call reload_config after editing MCP, source, skill, or other Pi configuration files, then call resource_status again to verify errors are gone.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const text = await getHost().resourceStatusText(callerAgentId);
			return { content: [{ type: "text" as const, text }], details: null };
		},
	});
}
