import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { buildNativeToolSet } from "../executor/native-tools.ts";
import {
	createDPiDispatchTools,
	type DPiDispatchLocalExecutors,
	type DPiDispatchParameterSchemas,
} from "../surface/dispatch-tools.ts";
import type { DPiRemoteExecutor, DPiRemoteToolResult } from "../surface/remote-executor.ts";
import type { HubChannel } from "./hub-channel.ts";

const TOOL_NAMES = ["bash", "read", "ls", "grep", "find", "write", "edit"] as const;

/**
 * Register the 7 `dispatch_*` tools on a server agent's extension API.
 */
export function createDispatchTools(channel: HubChannel, cwd: string) {
	const localExecutors = {} as DPiDispatchLocalExecutors;
	const parameterSchemas = {} as DPiDispatchParameterSchemas;
	const nativeTools = new Map(buildNativeToolSet(cwd).map((tool) => [tool.name, tool as NativeToolDefinition]));

	for (const nativeName of TOOL_NAMES) {
		const nativeDef = nativeTools.get(nativeName);
		if (!nativeDef) {
			throw new Error(`Missing d-pi native tool: ${nativeName}`);
		}
		parameterSchemas[nativeName] = nativeDef.parameters;
		localExecutors[nativeName] = (toolCallId, params, signal, onUpdate) =>
			nativeDef.execute(toolCallId, params, signal, onUpdate);
	}

	return createDPiDispatchTools({
		localExecutors,
		parameterSchemas,
		remoteExecutor: createRemoteExecutor(channel),
		sourceAgentName: channel.agentName,
	});
}

interface NativeToolDefinition {
	parameters: TSchema;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>>;
}

function createRemoteExecutor(channel: HubChannel): DPiRemoteExecutor {
	return {
		async executeRemoteTool(request): Promise<DPiRemoteToolResult> {
			const result = await channel.callDispatch(request.toolName, request.params, request.connectId);
			const dispatchResult = result as Partial<DPiRemoteToolResult>;
			return {
				requestId: request.requestId,
				ok: dispatchResult.ok === true,
				result: dispatchResult.result,
				error: dispatchResult.error,
			};
		},
	};
}
