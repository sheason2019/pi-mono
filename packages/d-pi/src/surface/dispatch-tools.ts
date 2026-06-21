import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { DPiRemoteExecutor } from "./remote-executor.ts";
import type { DPiTool, DPiToolDetails } from "./tool-surface.ts";
import { defineDPiTool } from "./tool-surface.ts";

export type DPiDispatchNativeToolName = "bash" | "read" | "ls" | "grep" | "find" | "write" | "edit";

export type DPiLocalToolExecutor = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<unknown>,
) => Promise<AgentToolResult<unknown>>;

export type DPiDispatchLocalExecutors = Record<DPiDispatchNativeToolName, DPiLocalToolExecutor>;

export type DPiDispatchParameterSchemas = Record<DPiDispatchNativeToolName, TSchema>;

export interface CreateDPiDispatchToolsOptions {
	localExecutors: DPiDispatchLocalExecutors;
	remoteExecutor: DPiRemoteExecutor;
	parameterSchemas?: Partial<DPiDispatchParameterSchemas>;
	sourceAgentName?: string;
}

const DISPATCH_TOOL_SPECS: Array<{ native: DPiDispatchNativeToolName; dispatch: string; label: string }> = [
	{ native: "bash", dispatch: "dispatch_bash", label: "Dispatch bash" },
	{ native: "read", dispatch: "dispatch_read", label: "Dispatch read" },
	{ native: "ls", dispatch: "dispatch_ls", label: "Dispatch ls" },
	{ native: "grep", dispatch: "dispatch_grep", label: "Dispatch grep" },
	{ native: "find", dispatch: "dispatch_find", label: "Dispatch find" },
	{ native: "write", dispatch: "dispatch_write", label: "Dispatch write" },
	{ native: "edit", dispatch: "dispatch_edit", label: "Dispatch edit" },
];

const EMPTY_PARAMETERS = Type.Object({});

export function createDPiDispatchTools(options: CreateDPiDispatchToolsOptions): DPiTool[] {
	return DISPATCH_TOOL_SPECS.map((spec) => {
		const nativeParameters = options.parameterSchemas?.[spec.native] ?? EMPTY_PARAMETERS;
		const parameters = withConnectIdParameter(nativeParameters);
		const localExecutor = options.localExecutors[spec.native];

		return defineDPiTool({
			name: spec.dispatch,
			label: spec.label,
			description:
				`Execute ${spec.native} either locally on the hub host or remotely on a connected d-pi client. ` +
				"Without the `connect_id` parameter, runs on the hub host (same as a local tool). " +
				"With `connect_id`, dispatches to the specified connected client device. " +
				"Use `connect_id` when the task targets the user's device (their laptop, local files, shell environment). " +
				"Omit `connect_id` when operating on the hub host. " +
				"Do NOT use `connect_id` to test whether a client is connected - only use it when you need to operate on the user's device for a specific task.",
			parameters,
			async execute(toolCallId, params, signal, onUpdate) {
				const paramsRecord = toRecord(params);
				const connectId = typeof paramsRecord.connect_id === "string" ? paramsRecord.connect_id : undefined;
				const nativeParams = stripConnectId(paramsRecord);

				if (!connectId) {
					return (await localExecutor(
						toolCallId,
						nativeParams,
						signal,
						onUpdate as AgentToolUpdateCallback<unknown> | undefined,
					)) as AgentToolResult<DPiToolDetails>;
				}

				try {
					const result = await options.remoteExecutor.executeRemoteTool({
						requestId: toolCallId,
						connectId,
						toolName: spec.native,
						params: nativeParams,
						sourceAgentName: options.sourceAgentName,
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
	return EMPTY_PARAMETERS;
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
