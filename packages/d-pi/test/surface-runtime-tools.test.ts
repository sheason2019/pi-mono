import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { DPiRuntimeHooks } from "../src/surface/index.ts";
import { createDPiReloadTool } from "../src/surface/runtime-tools.ts";
import type { DPiTool } from "../src/surface/tool-surface.ts";

const runtimeToolsPath = fileURLToPath(new URL("../src/surface/runtime-tools.ts", import.meta.url));

type ToolResult = Awaited<ReturnType<DPiTool["execute"]>>;

function isError(result: ToolResult): boolean {
	return Boolean((result as ToolResult & { isError?: boolean }).isError);
}

function resultText(result: ToolResult): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

function makeHooks(overrides: Partial<DPiRuntimeHooks> = {}): DPiRuntimeHooks {
	return {
		reloadContext: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		...overrides,
	};
}

describe("surface runtime tools source boundaries", () => {
	it("keeps reload tool independent from extension runtime APIs", async () => {
		const source = await readFile(runtimeToolsPath, "utf8");

		for (const forbidden of ["defineTool", "ExtensionAPI", "ResourceLoader", "ModelRegistry", "HubChannel"]) {
			expect(source).not.toContain(forbidden);
		}
	});
});

describe("createDPiReloadTool", () => {
	it("calls reloadContext and returns snapshot text with details", async () => {
		const reloadContext = vi.fn(async () => {});
		const tool = createDPiReloadTool({
			runtimeHooks: makeHooks({ reloadContext }),
			getSnapshot: () => ({
				snapshot: {
					skills: 2,
					skillNames: ["alpha", "beta"],
					systemPromptLen: 12,
					appendSystemPromptCount: 1,
					contextFiles: 3,
					contextFilePaths: ["/repo/AGENTS.md"],
				},
				details: {
					skills: 2,
					systemPromptLen: 12,
					contextFiles: 3,
				},
			}),
		});

		const result = await tool.execute("reload-1", {});

		expect(reloadContext).toHaveBeenCalledWith({ reason: "tool" });
		expect(isError(result)).toBe(false);
		expect(JSON.parse(resultText(result))).toEqual({
			skills: 2,
			skillNames: ["alpha", "beta"],
			systemPromptLen: 12,
			appendSystemPromptCount: 1,
			contextFiles: 3,
			contextFilePaths: ["/repo/AGENTS.md"],
		});
		expect(result.details).toEqual({
			skills: 2,
			systemPromptLen: 12,
			contextFiles: 3,
		});
	});

	it("returns isError when reload is unavailable", async () => {
		const tool = createDPiReloadTool({
			getSnapshot: () => ({ snapshot: {} }),
		});

		const result = await tool.execute("reload-unavailable", {});

		expect(isError(result)).toBe(true);
		expect(resultText(result)).toMatch(/not available/i);
	});

	it("returns isError when reloadContext throws", async () => {
		const reloadContext = vi.fn(async () => {
			throw new Error("reload exploded");
		});
		const tool = createDPiReloadTool({
			runtimeHooks: makeHooks({ reloadContext }),
			getSnapshot: () => ({ snapshot: {} }),
		});

		const result = await tool.execute("reload-fail", {});

		expect(isError(result)).toBe(true);
		expect(resultText(result)).toContain("reload exploded");
	});
});
