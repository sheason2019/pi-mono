import type { AgentModelDefinition } from "../agent-definition.ts";
import { getAgentDefinitionMetadata } from "../agent-definition.ts";
import { type LoadedAgentDefinition, readLoadedAgentDefinitionFromTs } from "../agent-loader.ts";
import type { AgentConfig } from "../types.ts";

function agentModelSpec(model: AgentModelDefinition): string {
	if ("id" in model) {
		const provider = typeof model.provider === "string" ? model.provider : model.provider.provider;
		return model.id.startsWith(`${provider}/`) ? model.id : `${provider}/${model.id}`;
	}
	return `${model.provider}/${model.name}`;
}

export function agentDefinitionToConfig(agent: LoadedAgentDefinition): AgentConfig {
	const toolNames = agent.tools.map((tool) => tool.name);
	const parentName = agent.parent ? getAgentDefinitionMetadata(agent.parent)?.name : undefined;
	return {
		name: agent.name,
		parentName,
		description: agent.description,
		roles: agent.roles,
		model: agent.model ? agentModelSpec(agent.model) : undefined,
		includeTools: toolNames.length > 0 ? toolNames : undefined,
	};
}

/**
 * Read `agent.ts` from an agent's cwd and return the normalized
 * config, or `undefined` if the file does not exist or is not
 * parseable in the standard d-pi shape.
 *
 * Used by the worker at session-start to inject the agent's
 * identity (name, description, parent, model, roles, tool
 * allow/deny lists) into the system prompt as the
 * "## Agent identity" section.
 */
export async function loadAgentIdentity(agentDir: string): Promise<AgentConfig | undefined> {
	try {
		const agent = await readLoadedAgentDefinitionFromTs(agentDir);
		if (agent) {
			return agentDefinitionToConfig(agent);
		}
		return undefined;
	} catch {
		process.stderr.write(`[d-pi] Failed to load agent.ts at ${agentDir}; skipping identity injection\n`);
		return undefined;
	}
}

/**
 * Format a parsed agent config as the "## Agent identity" section
 * that the worker appends to the agent's system prompt.
 *
 * The format is intentionally flat and key-value, not nested,
 * because every key is meant to be a single fact the LLM can
 * scan: who am I, what's my parent, what model do I run, what
 * tools can I reach, etc. We do not embed the entire JSON object
 * (which would be a maintenance liability if fields are renamed
 * or removed); we enumerate the known fields explicitly.
 *
 * Optional fields are omitted from the output entirely (rather
 * than rendered as `(unset)`) so the LLM doesn't learn false
 * defaults. `null`-valued fields (e.g. `parentName: null` for
 * the root agent) are also omitted — "I have no parent" is
 * implicit in the agent-tree, not a fact the LLM needs to know.
 */
export function formatAgentIdentitySection(config: AgentConfig): string {
	const lines: string[] = ["## Agent identity", ""];
	lines.push(`- name: \`${config.name}\``);

	if (config.description?.trim()) {
		lines.push("");
		lines.push(config.description.trim());
	}

	const meta: string[] = [];
	if (config.parentName) meta.push(`parent: \`${config.parentName}\``);
	if (config.roles && config.roles.length > 0) {
		meta.push(`roles: ${config.roles.map((r) => `\`${r}\``).join(", ")}`);
	}
	if (config.model) meta.push(`model: \`${config.model}\``);
	if (config.includeTools && config.includeTools.length > 0) {
		meta.push(`includeTools: ${config.includeTools.map((t) => `\`${t}\``).join(", ")}`);
	} else if (config.excludeTools && config.excludeTools.length > 0) {
		meta.push(`excludeTools: ${config.excludeTools.map((t) => `\`${t}\``).join(", ")}`);
	}

	if (meta.length > 0) {
		lines.push("");
		lines.push("Metadata (for self-reference; do not mention in user-bound prose):");
		for (const m of meta) lines.push(`- ${m}`);
	}

	return lines.join("\n");
}
