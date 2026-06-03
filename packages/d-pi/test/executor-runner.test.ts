import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ToolRunner } from "../src/executor/runner.ts";

// Hand-rolled tool-shaped objects — the runner only cares about `name` and
// `execute`, so we can keep the test decoupled from pi-coding-agent's full
// ToolDefinition contract.
const echoTool = {
	name: "echo",
	label: "echo",
	description: "echoes back",
	parameters: {} as never,
	execute: async (args: { text: string }) => ({
		content: [{ type: "text", text: args.text }],
	}),
} as unknown as ToolDefinition;

const throwsTool = {
	name: "throws",
	label: "throws",
	description: "throws",
	parameters: {} as never,
	execute: async () => {
		throw new Error("kaboom");
	},
} as unknown as ToolDefinition;

describe("ToolRunner", () => {
	it("runs a registered tool and returns the result", async () => {
		const r = new ToolRunner([echoTool]);
		const out = await r.run("echo", { text: "hi" });
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toEqual({ content: [{ type: "text", text: "hi" }] });
		}
	});

	it("returns error when tool throws", async () => {
		const r = new ToolRunner([throwsTool]);
		const out = await r.run("throws", {});
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.error).toBe("kaboom");
		}
	});

	it("returns error when tool name is unknown", async () => {
		const r = new ToolRunner([echoTool]);
		const out = await r.run("nope", {});
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.error).toMatch(/unknown tool/i);
		}
	});
});
