import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ToolRunner } from "../src/executor/runner.ts";

// Hand-rolled tool-shaped objects — the runner only cares about `name` and
// `execute`, so we can keep the test decoupled from pi-coding-agent's full
// ToolDefinition contract.
// Real ToolDefinition.execute is 5-arg (toolCallId, params, signal, onUpdate, ctx).
// The fake tools here mirror that shape so the runner's cast still resolves.
const echoTool = {
	name: "echo",
	label: "echo",
	description: "echoes back",
	parameters: {} as never,
	execute: async (_id: string, args: { text: string }, _signal?: unknown, _onUpdate?: unknown, _ctx?: unknown) => ({
		content: [{ type: "text", text: args.text }],
	}),
} as unknown as ToolDefinition;

const throwsTool = {
	name: "throws",
	label: "throws",
	description: "throws",
	parameters: {} as never,
	execute: async (_id?: string, _params?: unknown, _signal?: unknown, _onUpdate?: unknown, _ctx?: unknown) => {
		throw new Error("kaboom");
	},
} as unknown as ToolDefinition;

describe("ToolRunner", () => {
	it("runs a registered tool and returns the result", async () => {
		const r = new ToolRunner([echoTool]);
		const out = await r.run("call-1", "echo", { text: "hi" });
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toEqual({ content: [{ type: "text", text: "hi" }] });
		}
	});

	it("returns error when tool throws", async () => {
		const r = new ToolRunner([throwsTool]);
		const out = await r.run("call-2", "throws", {});
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.error).toBe("kaboom");
		}
	});

	it("returns error when tool name is unknown", async () => {
		const r = new ToolRunner([echoTool]);
		const out = await r.run("call-3", "nope", {});
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.error).toMatch(/unknown tool/i);
		}
	});
});
