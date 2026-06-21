import type { AgentDefinition, AgentTuiComponentRenderer } from "../agent-definition.ts";

export interface TuiComponentRendererRegistry {
	registerTuiComponentRenderer(customType: string, render: AgentTuiComponentRenderer): void;
}

export function installAgentTuiComponents(
	agent: Pick<AgentDefinition, "tuiComponents">,
	registry: TuiComponentRendererRegistry,
): void {
	for (const component of agent.tuiComponents ?? []) {
		registry.registerTuiComponentRenderer(component.customType, component.render);
	}
}
