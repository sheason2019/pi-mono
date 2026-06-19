export type DPiJsonPrimitive = string | number | boolean | null;
export type DPiJsonValue = DPiJsonPrimitive | DPiJsonValue[] | { [key: string]: DPiJsonValue };

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

export type DPiServiceEvent =
	| { type: "snapshot"; snapshot: DPiServiceSnapshot }
	| { type: "runtime"; event: string; data?: DPiJsonValue }
	| { type: "worker"; event: string; data?: DPiJsonValue };

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

export function isDPiJsonValue(value: unknown): value is DPiJsonValue {
	return isDPiJsonValueInternal(value, new WeakSet<object>());
}

export function toDPiJsonValue(value: unknown): DPiJsonValue {
	if (!isDPiJsonValue(value)) {
		throw new TypeError("Value is not JSON-safe");
	}
	return value;
}

export function isDPiServiceError(value: unknown): value is DPiServiceError {
	if (!isRecord(value)) {
		return false;
	}
	const error = value.error;
	if (!isRecord(error)) {
		return false;
	}
	return (
		typeof error.code === "string" &&
		typeof error.message === "string" &&
		(error.details === undefined || isDPiJsonValue(error.details))
	);
}

export function isDPiServiceSnapshot(value: unknown): value is DPiServiceSnapshot {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.agentName === "string" &&
		isDPiJsonValue(value.state) &&
		(value.runtime === undefined || isDPiJsonValue(value.runtime))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDPiJsonValueInternal(value: unknown, stack: WeakSet<object>): value is DPiJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value !== "object") {
		return false;
	}
	if (stack.has(value)) {
		return false;
	}
	stack.add(value);
	try {
		if (Array.isArray(value)) {
			if (!hasOnlyJsonArrayKeys(value)) {
				return false;
			}
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index)) {
					return false;
				}
				if (!isDPiJsonValueInternal(value[index], stack)) {
					return false;
				}
			}
			return true;
		}
		if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
			return false;
		}
		return Object.values(value).every((item) => isDPiJsonValueInternal(item, stack));
	} finally {
		stack.delete(value);
	}
}

function isPlainObject(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyJsonArrayKeys(value: unknown[]): boolean {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === "symbol") {
			return false;
		}
		if (key !== "length" && !isArrayElementKey(key, value.length)) {
			return false;
		}
	}
	return true;
}

function isArrayElementKey(key: string, length: number): boolean {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}
