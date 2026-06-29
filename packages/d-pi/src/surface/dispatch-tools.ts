import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import type { AgentToolDefinition } from "../agent-definition.ts";
import { defineTool } from "../agent-definition.ts";
import { isRecord } from "../shared/schemas.ts";
import { getBuiltinContext } from "./builtin-context.ts";
import type { DPiToolDetails } from "./tool-surface.ts";

export type DPiLocalToolExecutor = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<unknown>,
) => Promise<AgentToolResult<unknown>>;

const BashParameters = Type.Object({
	command: Type.String(),
	timeout_ms: Type.Optional(Type.Number()),
});

const ReadParameters = Type.Object({
	path: Type.String(),
});

function parseDispatchParams(params: unknown): {
	connectId: string | undefined;
	nativeParams: Record<string, unknown>;
} {
	if (!isRecord(params)) {
		return { connectId: undefined, nativeParams: {} };
	}
	const { connect_id, ...nativeParams } = params;
	return {
		connectId: typeof connect_id === "string" ? connect_id : undefined,
		nativeParams,
	};
}

export function createDispatchBashTool(): AgentToolDefinition {
	return createDispatchTool("bash", "Dispatch bash", BashParameters);
}

export function createDispatchReadTool(): AgentToolDefinition {
	return createDispatchTool("read", "Dispatch read", ReadParameters);
}

function createDispatchTool(nativeName: string, label: string, parameters: TSchema): AgentToolDefinition {
	const dispatchParameters = withConnectIdParameter(parameters);

	return defineTool({
		name: `dispatch_${nativeName}`,
		label,
		description:
			`Execute ${nativeName} either on the hub host or remotely on a connected d-pi client. ` +
			'Set `connect_id` to `"host"` to run on the hub host. ' +
			"Set `connect_id` to a connect_id string to dispatch to the specified connected client device. " +
			"Use the user's connect_id when the task targets the user's device (their laptop, local files, shell environment). " +
			'Use `"host"` when operating on the hub host. ' +
			"The `connect_id` parameter is required — do NOT omit it.",
		parameters: dispatchParameters,
		async execute(toolCallId, params, signal, onUpdate) {
			const ctx = getBuiltinContext();
			const { connectId, nativeParams } = parseDispatchParams(params);

			const localExecutor = ctx.localExecutors[nativeName];
			if (!localExecutor) {
				throw new Error(`No local executor registered for native tool: ${nativeName}`);
			}

			if (!connectId || connectId === "host") {
				return (await localExecutor(
					toolCallId,
					nativeParams,
					signal,
					onUpdate as AgentToolUpdateCallback<unknown> | undefined,
				)) as AgentToolResult<DPiToolDetails>;
			}

			try {
				const result = await ctx.remoteExecutor.executeRemoteTool({
					requestId: toolCallId,
					connectId,
					toolName: nativeName,
					params: nativeParams,
					sourceAgentName: ctx.agentName,
					signal,
				});

				if (!result.ok || result.error) {
					return errorTextResult(result.error ?? "remote dispatch returned ok=false");
				}
				return result.result as AgentToolResult<DPiToolDetails>;
			} catch (err) {
				if (signal?.aborted) {
					throw err;
				}
				return errorTextResult(errorMessage(err));
			}
		},
	});
}

function withConnectIdParameter(parameters: TSchema): TSchema {
	const base = toObjectSchema(parameters);
	const baseProperties = isRecord(base.properties) ? (base.properties as Record<string, TSchema>) : {};
	const baseRequired = Array.isArray(base.required) ? (base.required as string[]) : [];
	return {
		...base,
		type: "object",
		properties: {
			...baseProperties,
			connect_id: Type.String({
				description:
					'Required. The dispatch target. Set to "host" to run on the hub host. Set to a connect_id string to dispatch to the specified connected d-pi client device.',
			}),
		},
		required: [...baseRequired, "connect_id"],
	} as TSchema;
}

function toObjectSchema(parameters: TSchema): TSchema & { properties?: unknown; required?: unknown } {
	if (isRecord(parameters) && parameters.type === "object") {
		return parameters as TSchema & { properties?: unknown; required?: unknown };
	}
	return Type.Object({});
}

function errorTextResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		isError: true,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
