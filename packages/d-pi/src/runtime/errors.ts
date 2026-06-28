import { z } from "zod";
import type { DPiJsonValue, DPiRuntimeError, DPiRuntimeErrorCode } from "./types.ts";

const runtimeErrorCodes = new Set<DPiRuntimeErrorCode>([
	"busy",
	"auth",
	"invalid_session",
	"missing_model",
	"network",
	"executor_unavailable",
	"unknown",
]);

export interface DPiRuntimeErrorOptions {
	retryable?: boolean;
	details?: DPiJsonValue;
}

function isDPiJsonValue(value: unknown, visited: WeakSet<object> = new WeakSet<object>()): value is DPiJsonValue {
	if (value === null) {
		return true;
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value !== "object") {
		return false;
	}
	if (visited.has(value)) {
		return false;
	}
	visited.add(value);
	let valid: boolean;
	if (Array.isArray(value)) {
		valid = value.every((item) => isDPiJsonValue(item, visited));
	} else {
		const prototype = Object.getPrototypeOf(value);
		valid =
			(prototype === Object.prototype || prototype === null) &&
			Object.values(value as Record<string, unknown>).every((item) => isDPiJsonValue(item, visited));
	}
	visited.delete(value);
	return valid;
}

export function createDPiRuntimeError(
	code: DPiRuntimeErrorCode,
	message: string,
	options: DPiRuntimeErrorOptions = {},
): DPiRuntimeError {
	return {
		name: "DPiRuntimeError",
		code,
		message,
		retryable: options.retryable ?? false,
		...(options.details !== undefined ? { details: options.details } : {}),
	};
}

const dPiRuntimeErrorSchema = z.object({
	name: z.literal("DPiRuntimeError"),
	code: z.string().refine((code) => runtimeErrorCodes.has(code as DPiRuntimeErrorCode), {
		message: "Invalid error code",
	}),
	message: z.string(),
	retryable: z.boolean(),
	details: z.unknown().optional(),
});

export function isDPiRuntimeError(value: unknown): value is DPiRuntimeError {
	const parsed = dPiRuntimeErrorSchema.safeParse(value);
	if (!parsed.success) {
		return false;
	}
	return parsed.data.details === undefined || isDPiJsonValue(parsed.data.details);
}

export type { DPiRuntimeError, DPiRuntimeErrorCode };
