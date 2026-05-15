import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@sheason/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { HOST_PEER_ID } from "./host-peer.js";
import type { PeerToolBridge } from "./peer-tool-bridge.js";
import { createPeerToolSchema, preparePeerToolArguments, splitPeerToolArguments } from "./peer-tool-schema.js";

type HostExecutorPolicy = boolean | (() => boolean);

const PEER_TOOL_TIMEOUT_GRACE_MS = 5_000;

function resolveHostExecutorPolicy(policy: HostExecutorPolicy): boolean {
	return typeof policy === "function" ? policy() : policy;
}

function getPeerToolTimeoutMs(toolName: string, args: Record<string, unknown>): number | undefined {
	if (toolName !== "bash") {
		return undefined;
	}
	const timeout = args.timeout;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
		return undefined;
	}
	return Math.ceil(timeout * 1000) + PEER_TOOL_TIMEOUT_GRACE_MS;
}

function createPeerToolDefinition<TParams extends TSchema, TDetails, TState>(
	baseTool: ToolDefinition<TParams, TDetails, TState>,
	bridge: PeerToolBridge,
	allowHostExecutor: HostExecutorPolicy,
): ToolDefinition<TSchema, TDetails, TState> {
	const initialAllowHostExecutor = resolveHostExecutorPolicy(allowHostExecutor);
	const parameters = createPeerToolSchema(baseTool.parameters);
	return {
		name: baseTool.name,
		label: baseTool.label,
		description: initialAllowHostExecutor
			? `${baseTool.description} This tool is executed on the pi-hub host or a connected peer and requires an explicit peer-id.`
			: `${baseTool.description} This tool is executed on a connected peer and requires an explicit peer-id.`,
		promptSnippet: baseTool.promptSnippet,
		promptGuidelines: [
			...(baseTool.promptGuidelines ?? []),
			initialAllowHostExecutor
				? 'Provide peer-id explicitly for this tool call. Use "host" to execute on the pi-hub host workspace.'
				: "Provide peer-id explicitly for this tool call. The pi-hub host executor is disabled for this agent.",
			"Use group first when you do not know which peer-id is available.",
		],
		parameters,
		renderShell: baseTool.renderShell,
		executionMode: baseTool.executionMode,
		prepareArguments: (args) =>
			preparePeerToolArguments(
				args,
				baseTool.prepareArguments as ((input: unknown) => Record<string, unknown>) | undefined,
			) as Static<typeof parameters>,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { peerId, toolArgs } = splitPeerToolArguments(params as Record<string, unknown> & { "peer-id": string });
			if (peerId === HOST_PEER_ID) {
				if (!resolveHostExecutorPolicy(allowHostExecutor)) {
					throw new Error("Hub Executor is disabled for this agent.");
				}
				return baseTool.execute(toolCallId, toolArgs as Static<TParams>, signal, onUpdate, ctx);
			}
			return bridge.executeTool<TDetails>({
				toolCallId,
				toolName: baseTool.name,
				peerId,
				args: toolArgs,
				signal,
				onUpdate,
				timeoutMs: getPeerToolTimeoutMs(baseTool.name, toolArgs),
			});
		},
		renderCall: baseTool.renderCall as ToolDefinition<TSchema, TDetails, TState>["renderCall"],
		renderResult: baseTool.renderResult as ToolDefinition<TSchema, TDetails, TState>["renderResult"],
	};
}

export { HOST_PEER_ID } from "./host-peer.js";

export function createPeerToolDefinitions(
	cwd: string,
	bridge: PeerToolBridge,
	options: { allowHostExecutor?: HostExecutorPolicy } = {},
): ToolDefinition[] {
	const allowHostExecutor = options.allowHostExecutor ?? true;
	return [
		createPeerToolDefinition(createReadToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
		createPeerToolDefinition(createWriteToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
		createPeerToolDefinition(createEditToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
		createPeerToolDefinition(createBashToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
		createPeerToolDefinition(createGrepToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
		createPeerToolDefinition(createFindToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
		createPeerToolDefinition(createLsToolDefinition(cwd), bridge, allowHostExecutor) as ToolDefinition,
	];
}
