import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentToolDefinition } from "../agent-definition.ts";
import { defineTool } from "../agent-definition.ts";
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
			`Execute ${nativeName} either locally on the hub host or remotely on a connected d-pi client. ` +
			"Without the `connect_id` parameter, runs on the hub host (same as a local tool). " +
			"With `connect_id`, dispatches to the specified connected client device. " +
			"Use `connect_id` when the task targets the user's device (their laptop, local files, shell environment). " +
			"Omit `connect_id` when operating on the hub host. " +
			"Do NOT use `connect_id` to test whether a client is connected - only use it when you need to operate on the user's device for a specific task.",
		parameters: dispatchParameters,
		async execute(toolCallId, params, signal, onUpdate) {
			const ctx = getBuiltinContext();
			const paramsRecord = toRecord(params);
			const connectId = typeof paramsRecord.connect_id === "string" ? paramsRecord.connect_id : undefined;
			const nativeParams = stripConnectId(paramsRecord);

			const localExecutor = ctx.localExecutors[nativeName];
			if (!localExecutor) {
				throw new Error(`No local executor registered for native tool: ${nativeName}`);
			}

			if (!connectId) {
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
				});

				if (!result.ok || result.error) {
					return errorTextResult(result.error ?? "remote dispatch returned ok=false");
				}
				return result.result as AgentToolResult<DPiToolDetails>;
			} catch (err) {
				return errorTextResult(errorMessage(err));
			}
		},
	});
}

function withConnectIdParameter(parameters: TSchema): TSchema {
	const base = toObjectSchema(parameters);
	const baseProperties = isRecord(base.properties) ? (base.properties as Record<string, TSchema>) : {};
	return {
		...base,
		type: "object",
		properties: {
			...baseProperties,
			connect_id: Type.String({
				description:
					"Optional. The connect_id of the d-pi client to dispatch to. Omit to run locally on the hub host. Provide to run on the specified connected client device.",
			}),
		},
		...(Array.isArray(base.required) ? { required: base.required.filter((name) => name !== "connect_id") } : {}),
	} as TSchema;
}

function toObjectSchema(parameters: TSchema): TSchema & { properties?: unknown; required?: unknown } {
	if (isRecord(parameters) && parameters.type === "object") {
		return parameters as TSchema & { properties?: unknown; required?: unknown };
	}
	return Type.Object({});
}

function toRecord(params: Static<TSchema>): Record<string, unknown> {
	if (isRecord(params)) {
		return params;
	}
	return {};
}

function stripConnectId(params: Record<string, unknown>): Record<string, unknown> {
	const nativeParams: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (key !== "connect_id") {
			nativeParams[key] = value;
		}
	}
	return nativeParams;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
