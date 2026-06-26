import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentToolDefinition } from "../src/agent-definition.ts";
import { defineTool } from "../src/agent-definition.ts";
import { ToolRunner } from "../src/executor/runner.ts";

const echoParameters = Type.Object({
	text: Type.String(),
});

interface EchoDetails {
	seenId: string;
}

const echoArgCounts: number[] = [];

const echoTool: AgentToolDefinition = defineTool({
	name: "echo",
	label: "echo",
	description: "echoes back",
	parameters: echoParameters,
	execute: async (toolCallId, params) => {
		echoArgCounts.push(5);
		return {
			content: [{ type: "text", text: (params as { text: string }).text }],
			details: { seenId: toolCallId } as EchoDetails,
		};
	},
});

const emptyParameters = Type.Object({});

const throwsTool: AgentToolDefinition = defineTool({
	name: "throws",
	label: "throws",
	description: "throws",
	parameters: emptyParameters,
	execute: async () => {
		throw new Error("kaboom");
	},
});

describe("ToolRunner", () => {
	it("keeps the runner source independent from extension-specific tool APIs", async () => {
		const sourcePath = fileURLToPath(new URL("../src/executor/runner.ts", import.meta.url));
		const source = await readFile(sourcePath, "utf8");

		expect(source).not.toContain("ExtensionContext");
	});

	it("runs a registered tool and returns the result", async () => {
		echoArgCounts.length = 0;
		const r = new ToolRunner([echoTool]);
		const out = await r.run("call-1", "echo", { text: "hi" });
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toEqual({ content: [{ type: "text", text: "hi" }], details: { seenId: "call-1" } });
		}
		expect(echoArgCounts).toEqual([5]);
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
