import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AgentContextFileDefinition, AgentSkillDefinition } from "./agent-definition.ts";
import type { LoadedAgentDefinition } from "./agent-loader.ts";

export interface AgentRuntimeResources {
	agentsFiles: Array<{ path: string; content: string }>;
	appendSystemPrompt: string[];
}

function resolveAgentResourcePath(agent: LoadedAgentDefinition, path: string, description: string): string {
	const agentDir = resolve(agent.agentDir);
	const resolvedPath = resolve(agentDir, path);
	if (resolvedPath !== agentDir && !resolvedPath.startsWith(`${agentDir}${sep}`)) {
		throw new Error(`${description} must stay inside agent directory: ${path}`);
	}
	return resolvedPath;
}

function resolveAgentContextFilePath(agent: LoadedAgentDefinition, entry: AgentContextFileDefinition): string {
	return resolveAgentResourcePath(agent, entry.path, "Agent context file path");
}

export function resolveAgentSkillDir(agent: LoadedAgentDefinition, entry: AgentSkillDefinition): string {
	return resolveAgentResourcePath(agent, entry.dir, "Agent skills dir");
}

function readAgentContextFile(agent: LoadedAgentDefinition, entry: AgentContextFileDefinition): string | undefined {
	const resolvedPath = resolveAgentContextFilePath(agent, entry);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}

	try {
		return readFileSync(resolvedPath, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read context file ${resolvedPath}: ${message}`);
	}
}

export function loadAgentRuntimeResources(agent: LoadedAgentDefinition): AgentRuntimeResources {
	const agentsFiles: Array<{ path: string; content: string }> = [];
	const appendSystemPrompt: string[] = [];

	for (const entry of agent.contextFiles) {
		const content = readAgentContextFile(agent, entry);
		if (content === undefined) {
			continue;
		}

		if (entry.type === "context") {
			agentsFiles.push({
				path: resolveAgentContextFilePath(agent, entry),
				content,
			});
		} else {
			appendSystemPrompt.push(content);
		}
	}

	return { agentsFiles, appendSystemPrompt };
}

export function loadAgentRuntimeContextFiles(agent: LoadedAgentDefinition): Array<{ path: string; content: string }> {
	return loadAgentRuntimeResources(agent).agentsFiles;
}

export function loadAgentRuntimeSystemPromptBlocks(agent: LoadedAgentDefinition): string[] {
	return loadAgentRuntimeResources(agent).appendSystemPrompt;
}
