export type AgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

export interface PublicTeamAgentEntry {
	name: string;
	parentName: string | null | undefined;
	status: AgentStatus;
	children: string[];
}

export interface PublicTeamSnapshot {
	agents: PublicTeamAgentEntry[];
	rootName: string;
}
