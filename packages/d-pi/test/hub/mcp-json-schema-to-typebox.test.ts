import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { jsonSchemaToTypebox } from "../../src/hub/mcp/json-schema-to-typebox.js";

describe("jsonSchemaToTypebox", () => {
	it("returns Type.Any for null, non-object, and empty input", () => {
		const a = jsonSchemaToTypebox(null);
		const b = jsonSchemaToTypebox(undefined);
		const c = jsonSchemaToTypebox("x");
		expect(a).toEqual(Type.Any());
		expect(b).toEqual(Type.Any());
		expect(c).toEqual(Type.Any());
	});

	it("maps type string with optional description", () => {
		const s = jsonSchemaToTypebox({ type: "string", description: "d" });
		expect(s).toEqual(Type.String({ description: "d" }));
	});

	it("maps string with enum", () => {
		const s = jsonSchemaToTypebox({ type: "string", enum: ["a", "b"] });
		expect(s).toEqual(Type.Union([Type.Literal("a"), Type.Literal("b")], { description: undefined }));
	});

	it("maps type number with minimum and maximum", () => {
		const s = jsonSchemaToTypebox({ type: "number", minimum: 1, maximum: 9, description: "n" });
		expect(s).toEqual(Type.Number({ minimum: 1, maximum: 9, description: "n" }));
	});

	it("maps type integer with minimum and maximum", () => {
		const s = jsonSchemaToTypebox({ type: "integer", minimum: 0, maximum: 100 });
		expect(s).toEqual(Type.Integer({ minimum: 0, maximum: 100, description: undefined }));
	});

	it("maps type boolean", () => {
		const s = jsonSchemaToTypebox({ type: "boolean", description: "flag" });
		expect(s).toEqual(Type.Boolean({ description: "flag" }));
	});

	it("maps object with properties and required (recursive)", () => {
		const s = jsonSchemaToTypebox({
			type: "object",
			description: "root",
			properties: {
				nested: {
					type: "object",
					properties: { x: { type: "string" } },
					required: ["x"],
				},
				opt: { type: "number" },
			},
			required: ["nested"],
		});
		expect(s).toEqual(
			Type.Object(
				{
					nested: Type.Object(
						{
							x: Type.String({ description: undefined }),
						},
						{ description: undefined },
					),
					opt: Type.Optional(Type.Number({ description: undefined })),
				},
				{ description: "root" },
			),
		);
	});

	it("maps array with items", () => {
		const s = jsonSchemaToTypebox({
			type: "array",
			items: { type: "boolean" },
			description: "arr",
		});
		expect(s).toEqual(Type.Array(Type.Boolean({ description: undefined }), { description: "arr" }));
	});

	it("maps top-level enum without type (union of literals)", () => {
		const s = jsonSchemaToTypebox({ enum: [1, 2, 3], description: "e" });
		expect(s).toEqual(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], { description: "e" }));
	});

	it("maps string enum at any level in object property", () => {
		const s = jsonSchemaToTypebox({
			type: "object",
			properties: { status: { type: "string", enum: ["on", "off"] } },
			required: ["status"],
		});
		expect(s).toEqual(
			Type.Object(
				{
					status: Type.Union([Type.Literal("on"), Type.Literal("off")], { description: undefined }),
				},
				{ description: undefined },
			),
		);
	});

	it("never throws on hostile input", () => {
		for (const v of [
			{ type: "object", properties: null },
			{ type: "array", items: { $ref: "#/x" } },
			{ allOf: [{ type: "string" }, { type: "number" }] },
		]) {
			expect(() => jsonSchemaToTypebox(v)).not.toThrow();
			const r = jsonSchemaToTypebox(v);
			expect(r).toBeDefined();
		}
	});
});
