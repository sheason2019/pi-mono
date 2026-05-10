export const ROOT_AGENT_ID = "root";
/** @deprecated Use ROOT_AGENT_ID. Kept only for transitional imports. */
export const MAIN_AGENT_ID = ROOT_AGENT_ID;

export type AgentKind = "root" | "child";
export type AgentSpawnMode = "fork" | "spawn";
export type AgentLifecycle = "persistent" | "temporary";
export type HubExecutorPolicy = "enabled" | "disabled";

export interface NodeContainerExecutorConfig {
	id: string;
	type: "node-container";
	peerId: string;
	image: string;
	command: string[];
	token: string;
	env?: Record<string, string>;
	workdir?: string;
	containerName?: string;
}

export type AgentExecutorConfig = NodeContainerExecutorConfig;

export interface AgentRecord {
	id: string;
	kind: AgentKind;
	parentId?: string;
	name?: string;
	description?: string;
	sessionFile: string;
	createdAt: string;
	createdBy?: string;
	spawnMode?: AgentSpawnMode;
	background?: string;
	lifecycle: AgentLifecycle;
	reportResult?: boolean;
	hubExecutor?: HubExecutorPolicy;
	executors?: AgentExecutorConfig[];
}

export interface AgentRegistryFile {
	version: 2;
	agents: AgentRecord[];
}

export interface CreateChildAgentRecordInput {
	id?: string;
	parentId: string;
	name?: string;
	description?: string;
	sessionFile: string;
	createdBy?: string;
	spawnMode?: AgentSpawnMode;
	background?: string;
	lifecycle?: AgentLifecycle;
	reportResult?: boolean;
	hubExecutor?: HubExecutorPolicy;
	executors?: AgentExecutorConfig[];
}
