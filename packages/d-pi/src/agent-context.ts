import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AgentContextFileDefinition } from "./agent-definition.ts";
import type { LoadedAgentDefinition } from "./agent-loader.ts";

export interface AgentRuntimeResources {
	agentsFiles: Array<{ path: string; content: string }>;
	appendSystemPrompt: string[];
}

function resolveAgentContextFilePath(agent: LoadedAgentDefinition, entry: AgentContextFileDefinition): string {
	const agentDir = resolve(agent.agentDir);
	const resolvedPath = resolve(agentDir, entry.path);
	if (resolvedPath !== agentDir && !resolvedPath.startsWith(`${agentDir}${sep}`)) {
		throw new Error(`Agent context file path must stay inside agent directory: ${entry.path}`);
	}
	return resolvedPath;
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
