export type AgentStatus = "starting" | "ready" | "busy" | "error" | "destroyed";

export interface AgentPlanItem {
	id: string;
	title: string;
	description?: string;
	status: "pending" | "in_progress" | "completed";
}

export interface PublicTeamAgentEntry {
	name: string;
	parentName: string | null | undefined;
	status: AgentStatus;
	children: string[];
	plan: AgentPlanItem[];
	description?: string;
}

export interface PublicTeamSnapshot {
	agents: PublicTeamAgentEntry[];
	rootName: string;
}
