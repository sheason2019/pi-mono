import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPeerToolSchema } from "../../src/hub/tools/peer-tool-schema.js";

describe("peer tool schema", () => {
	it("exposes peer-routed tools as a plain object schema for tool-calling models", () => {
		const base = createReadToolDefinition("/tmp").parameters;
		const schema = createPeerToolSchema(base) as {
			type?: string;
			properties?: Record<string, unknown>;
			required?: string[];
			allOf?: unknown;
		};

		expect(schema.allOf).toBeUndefined();
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["limit", "offset", "path", "peer-id"]);
		expect(schema.required?.sort()).toEqual(["path", "peer-id"]);
	});
});
