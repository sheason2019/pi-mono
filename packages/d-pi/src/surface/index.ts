export {
	type DPiBuiltinContext,
	setBuiltinContext,
} from "./builtin-context.ts";
export type { DPiCommand, DPiCommandContext } from "./command-surface.ts";
export { defineDPiCommand } from "./command-surface.ts";
export {
	createDispatchBashTool,
	createDispatchReadTool,
	type DPiLocalToolExecutor,
} from "./dispatch-tools.ts";
export {
	createDPiHubActionsClient,
	type DPiAgentStatus,
	type DPiCreateAgentActionPayload,
	type DPiCreateAgentActionResult,
	type DPiDestroyAgentActionPayload,
	type DPiDispatchRemoteToolActionPayload,
	type DPiDispatchRemoteToolActionResult,
	type DPiHubActionRequest,
	type DPiHubActionsClient,
	type DPiHubActionsTransport,
	type DPiHubMessageMode,
	type DPiSendMessageActionPayload,
	type DPiSourceInfo,
	type DPiTeamAgentEntry,
	type DPiTeamExecutorEntry,
	type DPiTeamSnapshot,
} from "./hub-actions.ts";
export { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
export {
	createCreateAgentTool,
	createDestroyAgentTool,
	createReloadTool,
	createSendMessageTool,
	createTeamTool,
} from "./orchestration-tools.ts";
export type { DPiRemoteExecutor, DPiRemoteToolRequest, DPiRemoteToolResult } from "./remote-executor.ts";
export { defineDPiRemoteExecutor } from "./remote-executor.ts";
export type { DPiTool, DPiToolDefinition, DPiToolDetails, DPiToolExecute, DPiToolJsonValue } from "./tool-surface.ts";
export { defineDPiTool, dPiToolJsonDetails, dPiToolTextResult } from "./tool-surface.ts";
