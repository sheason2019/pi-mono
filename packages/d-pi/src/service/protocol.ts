import { z } from "zod";
import { jsonValueSchema } from "../shared/schemas.ts";

export type DPiJsonPrimitive = string | number | boolean | null;
export type DPiJsonValue = DPiJsonPrimitive | DPiJsonValue[] | { [key: string]: DPiJsonValue };

const dpiServiceErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: jsonValueSchema.optional(),
	}),
});

const dpiServiceSnapshotSchema = z.object({
	agentName: z.string(),
	state: jsonValueSchema,
	runtime: jsonValueSchema.optional(),
});

const dpiServiceSnapshotEventSchema = z.object({
	type: z.literal("snapshot"),
	snapshot: dpiServiceSnapshotSchema,
});

const dpiServiceRuntimeEventSchema = z.object({
	type: z.literal("runtime"),
	event: z.string(),
	data: jsonValueSchema.optional(),
});

const dpiServiceWorkerEventSchema = z.object({
	type: z.literal("worker"),
	event: z.string(),
	data: jsonValueSchema.optional(),
});

export const dPiServiceEventSchema = z.union([
	dpiServiceSnapshotEventSchema,
	dpiServiceRuntimeEventSchema,
	dpiServiceWorkerEventSchema,
]);

export const dPiServiceActionRequestSchema = z.object({
	text: z.string().min(1),
	options: jsonValueSchema.optional(),
});

export interface DPiServiceError {
	error: {
		code: string;
		message: string;
		details?: DPiJsonValue;
	};
}

export interface DPiServiceSnapshot {
	agentName: string;
	state: DPiJsonValue;
	runtime?: DPiJsonValue;
}

export type DPiServiceEvent = z.infer<typeof dPiServiceEventSchema>;

export interface DPiServiceActionRequest {
	text: string;
	options?: DPiJsonValue;
}

export type DPiServiceActionResult = { ok: true } | DPiServiceError;

export function dPiServiceError(code: string, message: string, details?: DPiJsonValue): DPiServiceError {
	return {
		error: {
			code,
			message,
			...(details === undefined ? {} : { details }),
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

function assertJsonSafeDeep(value: unknown, seen: WeakSet<object>): void {
	if (value === null) return;
	if (typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("JSON number must be finite");
		return;
	}
	if (typeof value === "object") {
		if (seen.has(value)) throw new TypeError("circular reference detected in JSON value");
		seen.add(value);
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				if (!(i in value)) throw new TypeError("sparse arrays are not JSON-safe");
				assertJsonSafeDeep(value[i], seen);
			}
			for (const key of Object.keys(value)) {
				const idx = Number(key);
				if (!(Number.isInteger(idx) && idx >= 0 && idx < value.length)) {
					assertJsonSafeDeep((value as unknown as Record<string, unknown>)[key], seen);
				}
			}
		} else if (isPlainObject(value)) {
			for (const v of Object.values(value)) {
				assertJsonSafeDeep(v, seen);
			}
		} else {
			throw new TypeError("value must be a plain object, array, or JSON primitive");
		}
		seen.delete(value);
		return;
	}
	throw new TypeError(`value of type ${typeof value} cannot be represented as JSON`);
}

export function isDPiJsonValue(value: unknown): value is DPiJsonValue {
	try {
		assertJsonSafeDeep(value, new WeakSet());
		return true;
	} catch {
		return false;
	}
}

export function toDPiJsonValue(value: unknown): DPiJsonValue {
	assertJsonSafeDeep(value, new WeakSet());
	return jsonValueSchema.parse(value) as DPiJsonValue;
}

export function isDPiServiceError(value: unknown): value is DPiServiceError {
	return dpiServiceErrorSchema.safeParse(value).success;
}

export function isDPiServiceSnapshot(value: unknown): value is DPiServiceSnapshot {
	return dpiServiceSnapshotSchema.safeParse(value).success;
}
