import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export type DPiToolJsonValue =
	| null
	| boolean
	| number
	| string
	| DPiToolJsonValue[]
	| { [key: string]: DPiToolJsonValue };

export interface DPiToolDetails {
	[key: string]: DPiToolJsonValue;
}

export function toolTextResult(text: string, details: DPiToolDetails = {}): AgentToolResult<DPiToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function toolJsonDetails(value: unknown): DPiToolDetails {
	const jsonValue = toToolJsonValue(value, "details");
	if (!isToolJsonObject(jsonValue)) {
		throw new TypeError("Tool details must be a plain JSON object");
	}
	return jsonValue;
}

function toToolJsonValue(value: unknown, path: string): DPiToolJsonValue | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(`Tool details cannot contain non-finite number at ${path}`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => {
			const jsonItem = toToolJsonValue(item, `${path}[${index}]`);
			if (jsonItem === undefined) {
				throw new TypeError(`Tool details cannot contain undefined array item at ${path}[${index}]`);
			}
			return jsonItem;
		});
	}
	if (isPlainObject(value)) {
		const result: { [key: string]: DPiToolJsonValue } = {};
		for (const [key, item] of Object.entries(value)) {
			const jsonItem = toToolJsonValue(item, `${path}.${key}`);
			if (jsonItem !== undefined) {
				result[key] = jsonItem;
			}
		}
		return result;
	}
	throw new TypeError(`Tool details must be JSON-safe at ${path}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isToolJsonObject(value: DPiToolJsonValue | undefined): value is DPiToolDetails {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
