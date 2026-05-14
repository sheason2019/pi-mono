import type { HubLogEntry } from "./hub-log.js";

export interface HubTuiAgentView {
	id: string;
	name?: string;
	description?: string;
	kind: "root" | "child" | "guest";
	isRunning: boolean;
	hydrationStatus?: "running" | "loading" | "not_hydrated" | "error";
	peerCount: number;
	sessionFile: string;
	lastError?: string;
	lastRunDurationMs?: number;
}

export interface HubTuiStatusCounts {
	starting: number;
	running: number;
	stopped: number;
	error: number;
}

export interface HubTuiResourceView {
	mcpServers: number;
	mcpStatusCounts?: HubTuiStatusCounts;
	sources: number;
	sourceStatusCounts?: HubTuiStatusCounts;
	skills: number;
	prompts: number;
	themes: number;
}

export interface HubTuiViewModel {
	status: "starting" | "running" | "stopping" | "error";
	address?: string;
	workspace: string;
	rootToken?: string;
	hubVersion?: string;
	protocolVersion: number;
	agents: HubTuiAgentView[];
	resources: HubTuiResourceView;
	logs: HubLogEntry[];
}
