import { getAgentDefinitionMetadata } from "../agent-definition.ts";
import { type LoadedAgentDefinition, readLoadedAgentDefinitionFromTs } from "../agent-loader.ts";
import type { AgentConfig } from "../types.ts";

export function agentDefinitionToConfig(agent: LoadedAgentDefinition): AgentConfig {
	const parentName = agent.parent ? getAgentDefinitionMetadata(agent.parent)?.name : undefined;
	return {
		name: agent.name,
		parentName,
		description: agent.description,
		roles: agent.roles,
	};
}

/**
 * Read `agent.ts` from an agent's cwd and return the normalized
 * config, or `undefined` if the file does not exist or is not
 * parseable in the standard d-pi shape.
 *
 * Used by the worker at session-start to inject the agent's
 * identity (name, description, parent, roles) into the system prompt as the
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
 * scan: who am I, what's my parent, what role am I serving, etc.
 * We do not embed the entire JSON object
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

	if (meta.length > 0) {
		lines.push("");
		lines.push("Metadata (for self-reference; do not mention in user-bound prose):");
		for (const m of meta) lines.push(`- ${m}`);
	}

	return lines.join("\n");
}
