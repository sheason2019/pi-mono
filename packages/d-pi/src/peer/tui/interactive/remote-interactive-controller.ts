import type { McpRuntimeStatus, SessionGetSkillsAck, SourceRuntimeStatus } from "../../../hub/index.js";
import { getVisiblePeerCommands } from "../../commands/index.js";
import type { PeerAppSnapshot } from "../../state/peer-app-state.js";
import type { PeerUiSnapshot } from "../../state/peer-ui-state.js";
import type { PeerThinkingLevel } from "../../types.js";
import type { RemoteInteractiveActions } from "./remote-interactive-actions.js";
import type { RemoteInteractiveCapabilities } from "./remote-interactive-capabilities.js";
import { createRemoteInteractiveView } from "./remote-interactive-state.js";
import type { RemoteInteractiveView } from "./remote-interactive-view.js";

export interface RemoteInteractiveController {
	getView(): RemoteInteractiveView;
	actions: RemoteInteractiveActions;
	capabilities: RemoteInteractiveCapabilities;
}

export interface RemoteInteractiveRuntimeBridge {
	hello: {
		peerId: string;
		cwd?: string;
		agentId?: string;
	};
	queueWrite?: (text: string) => Promise<void>;
	queueFlush?: () => Promise<void>;
	submitPrompt?: (text: string) => Promise<void>;
	followUp?: (text: string) => Promise<void>;
	steer?: (text: string) => Promise<void>;
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
	appState: {
		getSnapshot(): PeerAppSnapshot;
	};
	uiState: {
		getSnapshot(): PeerUiSnapshot;
	};
}

export function createRemoteInteractiveController(
	runtime: RemoteInteractiveRuntimeBridge,
	capabilityOverrides: Partial<RemoteInteractiveCapabilities> = {},
): RemoteInteractiveController {
	const capabilities: RemoteInteractiveCapabilities = {
		supportsCompact: true,
		supportsReload: true,
		supportsModelSelection: true,
		supportsSessionTree: false,
		supportsSessionCreation: false,
		supportsSessionResume: false,
		supportsSessionFork: false,
		supportsSessionClone: false,
		...capabilityOverrides,
	};
	return {
		getView: () =>
			createRemoteInteractiveView(runtime.appState.getSnapshot(), runtime.uiState.getSnapshot(), {
				peerId: runtime.hello.peerId,
				cwd: runtime.hello.cwd ?? process.cwd(),
				visibleCommands: getVisiblePeerCommands(capabilities),
				helloAgentId: runtime.hello.agentId,
			}),
		actions: {
			queueWrite: (text: string) => {
				if (runtime.queueWrite) {
					return runtime.queueWrite(text);
				}
				if (runtime.submitPrompt) {
					return runtime.submitPrompt(text);
				}
				throw new Error("Queue write action is not available.");
			},
			queueFlush: () => {
				if (!runtime.queueFlush) {
					throw new Error("Queue flush action is not available.");
				}
				return runtime.queueFlush();
			},
			submitPrompt: (text: string) => {
				if (runtime.queueWrite) {
					return runtime.queueWrite(text);
				}
				if (runtime.submitPrompt) {
					return runtime.submitPrompt(text);
				}
				throw new Error("Queue write action is not available.");
			},
			submitFollowUp: (text: string) => {
				if (runtime.queueWrite) {
					return runtime.queueWrite(text);
				}
				if (runtime.followUp) {
					return runtime.followUp(text);
				}
				if (runtime.submitPrompt) {
					return runtime.submitPrompt(text);
				}
				throw new Error("Queue write action is not available.");
			},
			steer: (text: string) => {
				if (runtime.queueWrite) {
					return runtime.queueWrite(text);
				}
				if (runtime.steer) {
					return runtime.steer(text);
				}
				if (runtime.submitPrompt) {
					return runtime.submitPrompt(text);
				}
				throw new Error("Queue write action is not available.");
			},
			abort: () => runtime.abort(),
			switchAgent: (agentId: string) => {
				if (!runtime.switchAgent) {
					throw new Error("Agent switching action is not available.");
				}
				return runtime.switchAgent(agentId);
			},
			setModel: (modelResourceId: string) => runtime.setModel(modelResourceId),
			setThinkingLevel: (level) => runtime.setThinkingLevel(level),
			invokeCommand: (commandName: string, args?: string) => runtime.invokeCommand(commandName, args),
			getSessionSources: () => runtime.getSessionSources(),
			pauseSource: (resourceId: string) => runtime.pauseSource(resourceId),
			restartSource: (resourceId: string) => runtime.restartSource(resourceId),
			removeSource: (resourceId: string) => runtime.removeSource(resourceId),
			getMcpServers: () => runtime.getMcpServers(),
			getSkills: () => runtime.getSkills?.() ?? Promise.resolve({ ok: true, skills: [], diagnostics: [] }),
			pauseMcpServer: (name: string) => runtime.pauseMcpServer(name),
			restartMcpServer: (name: string) => runtime.restartMcpServer(name),
			removeMcpServer: (name: string) => runtime.removeMcpServer(name),
			retryConnection: () => runtime.retryConnection?.(),
		},
		capabilities,
	};
}
