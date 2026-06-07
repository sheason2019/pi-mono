import { describe, expect, it } from "vitest";
import { validateLine } from "../src/hub/source-validator.ts";

describe("validateLine", () => {
	it("parses a valid notification", () => {
		const line = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { type: "lark.message", id: "om_xxx", data: {} },
		});
		const result = validateLine(line);
		expect(result.kind).toBe("notification");
		if (result.kind === "notification") {
			expect(result.payload.method).toBe("events.emit");
		}
	});

	it("drops invalid JSON", () => {
		const result = validateLine("not json {");
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") {
			expect(result.reason).toMatch(/json/i);
		}
	});

	it("drops JSON without jsonrpc field", () => {
		const result = validateLine(JSON.stringify({ method: "x" }));
		expect(result.kind).toBe("invalid");
	});

	it("drops JSON without method", () => {
		const result = validateLine(JSON.stringify({ jsonrpc: "2.0" }));
		expect(result.kind).toBe("invalid");
	});

	it("parses a request but marks it for silent drop", () => {
		const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });
		const result = validateLine(line);
		expect(result.kind).toBe("request");
	});

	it("parses a response but marks it for silent drop", () => {
		const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
		const result = validateLine(line);
		expect(result.kind).toBe("response");
	});

	it("does not throw on edge cases", () => {
		const edges = [
			"",
			" ",
			"null",
			"[]",
			'{"jsonrpc":"2.0"}',
			'{"jsonrpc":"1.0","method":"x"}',
			'{"jsonrpc":"2.0","method":""}',
			'{"jsonrpc":"2.0","method":123}',
			'{"jsonrpc":"2.0","method":"x","id":null}',
			'{"jsonrpc":"2.0","method":"x","result":{"a":1}}',
		];
		for (const edge of edges) {
			expect(validateLine(edge)).toBeDefined();
		}
	});
});
