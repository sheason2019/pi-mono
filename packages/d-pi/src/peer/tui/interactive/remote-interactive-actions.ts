import type { McpRuntimeStatus, SessionGetSkillsAck, SourceRuntimeStatus } from "../../../hub/index.js";
import type { PeerThinkingLevel } from "../../types.js";

export interface RemoteInteractiveActions {
	queueWrite?: (text: string) => Promise<void>;
	queueFlush?: () => Promise<void>;
	/** Legacy test/runtime adapters; interactive mode prefers queueWrite/queueFlush. */
	submitPrompt(text: string): Promise<void>;
	submitFollowUp(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	switchAgent?(agentId: string): Promise<void>;
	setModel(modelResourceId: string): Promise<void>;
	setThinkingLevel(level: PeerThinkingLevel): Promise<void>;
	invokeCommand(commandName: string, args?: string): Promise<void>;
	getSessionSources(): Promise<SourceRuntimeStatus[]>;
	pauseSource(resourceId: string): Promise<SourceRuntimeStatus[]>;
	restartSource(resourceId: string): Promise<SourceRuntimeStatus[]>;
	removeSource(resourceId: string): Promise<SourceRuntimeStatus[]>;
	getMcpServers(): Promise<{ servers: McpRuntimeStatus[]; configError?: string }>;
	getSkills?(): Promise<Extract<SessionGetSkillsAck, { ok: true }>>;
	pauseMcpServer(name: string): Promise<McpRuntimeStatus[]>;
	restartMcpServer(name: string): Promise<McpRuntimeStatus[]>;
	removeMcpServer(name: string): Promise<McpRuntimeStatus[]>;
	retryConnection?(): Promise<void> | void;
}
