import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, TeamAgentEntry, TeamSnapshot } from "../types.ts";

export const AGENT_SWITCH_FILE = join(tmpdir(), "d-pi-agent-switch.txt");

export function statusIndicator(status: AgentStatus): string {
	switch (status) {
		case "busy":
			return "\u25CF";
		case "ready":
			return "\u25CB";
		case "starting":
			return "\u25CC";
		case "error":
			return "\u2715";
		default:
			return "\u25CB";
	}
}

export function formatAgentEntry(agent: TeamAgentEntry, depth: number, isLast: boolean, isCurrent: boolean): string {
	let indent = "";
	if (depth > 0) {
		indent = "\u2502 ".repeat(depth - 1);
		indent += isLast ? "\u2514 " : "\u251C ";
	}
	const indicator = statusIndicator(agent.status);
	const current = isCurrent ? " \u25C0" : "";
	return `${indent}${indicator} ${agent.name}${current}\t${agent.name}`;
}

export function parseAgentName(selected: string): string | undefined {
	const tabIdx = selected.lastIndexOf("\t");
	if (tabIdx === -1) return undefined;
	return selected.slice(tabIdx + 1);
}

export async function fetchTeamSnapshot(hubUrl: string, authToken?: string): Promise<TeamSnapshot> {
	const headers: Record<string, string> = {};
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	}
	const response = await fetch(`${hubUrl}/api/team`, { headers });
	if (!response.ok) {
		throw new Error(`Failed to fetch team: ${response.status}`);
	}
	return (await response.json()) as TeamSnapshot;
}

export function buildAgentSelectOptions(network: TeamSnapshot, currentAgentName?: string): string[] {
	const agentMap = new Map(network.agents.map((a) => [a.name, a]));
	const options: string[] = [];

	const walkTree = (agentName: string, depth: number, isLast = true): void => {
		const agent = agentMap.get(agentName);
		if (!agent) return;
		options.push(formatAgentEntry(agent, depth, isLast, agent.name === currentAgentName));
		for (let i = 0; i < agent.children.length; i++) {
			walkTree(agent.children[i], depth + 1, i === agent.children.length - 1);
		}
	};

	if (network.rootName) {
		walkTree(network.rootName, 0);
	}

	const visited = new Set<string>();
	const collectVisited = (agentName: string): void => {
		visited.add(agentName);
		const agent = agentMap.get(agentName);
		if (agent) for (const childName of agent.children) collectVisited(childName);
	};
	if (network.rootName) collectVisited(network.rootName);
	for (const agent of network.agents) {
		if (!visited.has(agent.name)) {
			options.push(formatAgentEntry(agent, 0, true, agent.name === currentAgentName));
		}
	}

	return options;
}

export function switchAgent(agentName: string): void {
	writeFileSync(AGENT_SWITCH_FILE, agentName, "utf-8");
}
