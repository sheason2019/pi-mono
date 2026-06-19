import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";

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

export type DPiToolExecute<TParameters extends TSchema, TDetails extends DPiToolDetails = DPiToolDetails> = (
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails>,
) => Promise<AgentToolResult<TDetails>>;

export interface DPiToolDefinition<TParameters extends TSchema, TDetails extends DPiToolDetails = DPiToolDetails>
	extends Omit<AgentTool<TParameters, TDetails>, "execute"> {
	execute: DPiToolExecute<TParameters, TDetails>;
}

export type DPiTool<
	TParameters extends TSchema = TSchema,
	TDetails extends DPiToolDetails = DPiToolDetails,
> = AgentTool<TParameters, TDetails>;

export function defineDPiTool<TParameters extends TSchema, TDetails extends DPiToolDetails = DPiToolDetails>(
	tool: DPiToolDefinition<TParameters, TDetails>,
): DPiTool<TParameters, TDetails> {
	return tool;
}

export function dPiToolTextResult(text: string, details: DPiToolDetails = {}): AgentToolResult<DPiToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function dPiToolJsonDetails(value: unknown): DPiToolDetails {
	const jsonValue = toDPiToolJsonValue(value, "details");
	if (!isDPiToolJsonObject(jsonValue)) {
		throw new TypeError("DPi tool details must be a plain JSON object");
	}
	return jsonValue;
}

function toDPiToolJsonValue(value: unknown, path: string): DPiToolJsonValue | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(`DPi tool details cannot contain non-finite number at ${path}`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => {
			const jsonItem = toDPiToolJsonValue(item, `${path}[${index}]`);
			if (jsonItem === undefined) {
				throw new TypeError(`DPi tool details cannot contain undefined array item at ${path}[${index}]`);
			}
			return jsonItem;
		});
	}
	if (isPlainObject(value)) {
		const result: { [key: string]: DPiToolJsonValue } = {};
		for (const [key, item] of Object.entries(value)) {
			const jsonItem = toDPiToolJsonValue(item, `${path}.${key}`);
			if (jsonItem !== undefined) {
				result[key] = jsonItem;
			}
		}
		return result;
	}
	throw new TypeError(`DPi tool details must be JSON-safe at ${path}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isDPiToolJsonObject(value: DPiToolJsonValue | undefined): value is DPiToolDetails {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
