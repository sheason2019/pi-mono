import { z } from "zod";

export const nonEmptyString = z.string().min(1);
export const safeIdentifier = z.string().regex(/^[A-Za-z0-9._-]+$/);

export const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
	const parsed = JSON.parse(raw) as unknown;
	return schema.parse(parsed);
}

export function safeParseJson<T>(raw: string, schema: z.ZodType<T>): z.SafeParseReturnType<T, T> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return schema.safeParse(parsed);
	} catch (err) {
		return {
			success: false,
			error:
				err instanceof z.ZodError
					? err
					: new z.ZodError([
							{ code: "custom", message: err instanceof Error ? err.message : String(err), path: [] },
						]),
		};
	}
}
