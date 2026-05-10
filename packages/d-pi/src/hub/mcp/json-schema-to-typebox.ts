import type { TNumberOptions, TObjectOptions, TStringOptions } from "typebox";
import { type TSchema, Type } from "typebox";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDescription(schema: Record<string, unknown>): string | undefined {
	const d = schema.description;
	return typeof d === "string" ? d : undefined;
}

function toNumberOptions(schema: Record<string, unknown>, description: string | undefined): TNumberOptions {
	const o: TNumberOptions = {};
	if (description !== undefined) {
		o.description = description;
	}
	if (typeof schema.minimum === "number") {
		o.minimum = schema.minimum;
	}
	if (typeof schema.maximum === "number") {
		o.maximum = schema.maximum;
	}
	return o;
}

function toIntegerOptions(schema: Record<string, unknown>, description: string | undefined): TNumberOptions {
	return toNumberOptions(schema, description);
}

function toStringOptions(_schema: Record<string, unknown>, description: string | undefined): TStringOptions {
	const o: TStringOptions = {};
	if (description !== undefined) {
		o.description = description;
	}
	return o;
}

function enumToUnionLiterals(enumValues: unknown, description: string | undefined): TSchema {
	if (!Array.isArray(enumValues) || enumValues.length === 0) {
		return description !== undefined ? Type.Any({ description }) : Type.Any();
	}
	const literals = enumValues.map((v) => Type.Literal(v as string | number | boolean));
	if (literals.length === 1) {
		const v = enumValues[0] as string | number | boolean;
		return description !== undefined ? Type.Literal(v, { description }) : Type.Literal(v);
	}
	const tuple = literals as unknown as [TSchema, TSchema, ...TSchema[]];
	if (description !== undefined) {
		return Type.Union(tuple, { description });
	}
	return Type.Union(tuple);
}

/**
 * Best-effort JSON Schema → typebox (Type) conversion for MCP `inputSchema` values.
 * Never throws; returns `Type.Any()` when a shape is not recognized.
 */
export function jsonSchemaToTypebox(schema: unknown): TSchema {
	if (!isRecord(schema)) {
		return Type.Any();
	}

	if ("enum" in schema && !("type" in schema)) {
		return enumToUnionLiterals(schema.enum, readDescription(schema));
	}

	const type = schema.type;
	if (type === "string") {
		if (Array.isArray(schema.enum) && schema.enum.length > 0) {
			return enumToUnionLiterals(schema.enum, readDescription(schema));
		}
		return Type.String(toStringOptions(schema, readDescription(schema)));
	}
	if (type === "number") {
		return Type.Number(toNumberOptions(schema, readDescription(schema)));
	}
	if (type === "integer") {
		return Type.Integer(toIntegerOptions(schema, readDescription(schema)));
	}
	if (type === "boolean") {
		const desc = readDescription(schema);
		return Type.Boolean(desc !== undefined ? { description: desc } : {});
	}
	if (type === "array") {
		const items = schema.items;
		const desc = readDescription(schema);
		const itemSchema: TSchema = isRecord(items) ? jsonSchemaToTypebox(items) : Type.Any();
		if (desc !== undefined) {
			return Type.Array(itemSchema, { description: desc });
		}
		return Type.Array(itemSchema);
	}
	if (type === "object") {
		const desc = readDescription(schema);
		const properties = schema.properties;
		if (!isRecord(properties)) {
			const opt: TObjectOptions = {};
			if (desc !== undefined) {
				opt.description = desc;
			}
			return Type.Object({}, Object.keys(opt).length > 0 ? opt : undefined);
		}
		const requiredRaw = schema.required;
		const required = new Set(
			Array.isArray(requiredRaw) ? requiredRaw.filter((k): k is string => typeof k === "string") : [],
		);
		const shape: Record<string, TSchema> = {};
		for (const [key, value] of Object.entries(properties)) {
			const child = jsonSchemaToTypebox(value);
			shape[key] = required.has(key) ? child : Type.Optional(child);
		}
		if (desc !== undefined) {
			return Type.Object(shape, { description: desc });
		}
		return Type.Object(shape);
	}
	if (type === "null") {
		return Type.Null({ ...(readDescription(schema) !== undefined ? { description: readDescription(schema)! } : {}) });
	}
	return Type.Any();
}
