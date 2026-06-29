export {
	type DPiBuiltinContext,
	setBuiltinContext,
} from "./builtin-context.ts";
export {
	createDispatchBashTool,
	createDispatchReadTool,
	type DPiLocalToolExecutor,
} from "./dispatch-tools.ts";
export {
	createHubActionsClient,
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
	type DPiReloadWorkspaceResult,
	type DPiSendMessageActionPayload,
	type DPiTeamAgentEntry,
	type DPiTeamExecutorEntry,
	type DPiTeamSnapshot,
} from "./hub-actions.ts";
export { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
export {
	createCreateAgentTool,
	createDestroyAgentTool,
	createPlanTool,
	createReloadTool,
	createReloadWorkspaceTool,
	createSendMessageTool,
	createTeamTool,
} from "./orchestration-tools.ts";
export type { DPiRemoteExecutor, DPiRemoteToolRequest, DPiRemoteToolResult } from "./remote-executor.ts";
export { defineRemoteExecutor } from "./remote-executor.ts";
export type { DPiToolDetails, DPiToolJsonValue } from "./tool-surface.ts";
export { toolJsonDetails, toolTextResult } from "./tool-surface.ts";
