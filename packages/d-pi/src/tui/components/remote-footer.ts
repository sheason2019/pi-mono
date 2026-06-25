import type { DPiJsonValue, DPiServiceSnapshot } from "../../service/protocol.ts";
import type { DPiRemoteTuiConnectionState } from "../remote-tui.ts";

export interface DPiRemoteFooterViewModel {
	segments: readonly string[];
	text: string;
}

export interface BuildRemoteFooterViewOptions {
	snapshot?: DPiServiceSnapshot;
	connectionState: DPiRemoteTuiConnectionState;
}

export function buildRemoteFooterView(options: BuildRemoteFooterViewOptions): DPiRemoteFooterViewModel {
	const state = asRecord(options.snapshot?.state);
	const segments = [
		`agent ${options.snapshot?.agentName ?? "unknown"}`,
		options.connectionState,
		...activitySegments(state),
		...queueSegments(state),
		...modelSegments(state),
	];
	return {
		segments,
		text: segments.join(" | "),
	};
}

function activitySegments(state: Record<string, DPiJsonValue> | undefined): string[] {
	const streaming = booleanField(state, "streaming") ?? booleanField(asRecord(state?.streaming), "active");
	const busy = booleanField(state, "busy") ?? stringField(state, "status") === "busy";
	const segments: string[] = [];
	if (streaming) {
		segments.push("streaming");
	}
	if (busy) {
		segments.push("busy");
	}
	return segments;
}

function queueSegments(state: Record<string, DPiJsonValue> | undefined): string[] {
	const queued = numberField(state, "queued") ?? queueLength(asRecord(state?.queues));
	return queued === undefined || queued === 0 ? [] : [`queued ${queued}`];
}

function modelSegments(state: Record<string, DPiJsonValue> | undefined): string[] {
	const model = stringField(state, "model") ?? stringField(asRecord(state?.model), "id");
	return model ? [`model ${model}`] : [];
}

function queueLength(queues: Record<string, DPiJsonValue> | undefined): number | undefined {
	if (!queues) {
		return undefined;
	}
	const prompts = asArray(queues.prompts)?.length ?? 0;
	const tools = asArray(queues.tools)?.length ?? 0;
	return prompts + tools;
}

function booleanField(record: Record<string, DPiJsonValue> | undefined, key: string): boolean | undefined {
	const value = record?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function numberField(record: Record<string, DPiJsonValue> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" ? value : undefined;
}

function stringField(record: Record<string, DPiJsonValue> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: DPiJsonValue | undefined): Record<string, DPiJsonValue> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function asArray(value: DPiJsonValue | undefined): DPiJsonValue[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
