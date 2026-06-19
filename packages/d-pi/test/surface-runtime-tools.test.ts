import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { DPiRuntimeHooks } from "../src/surface/index.ts";
import {
	createDPiReloadTool,
	createDPiRuntimeTools,
	createDPiSetModelTool,
	createDPiSetThinkingLevelTool,
	type DPiRuntimeModelEntry,
	type DPiRuntimeModelResolver,
} from "../src/surface/runtime-tools.ts";
import type { DPiTool } from "../src/surface/tool-surface.ts";

const runtimeToolsPath = fileURLToPath(new URL("../src/surface/runtime-tools.ts", import.meta.url));
const reloadToolsPath = fileURLToPath(new URL("../src/extension/reload-tools.ts", import.meta.url));
const agentMetadataPath = fileURLToPath(new URL("../src/extension/agent-metadata.ts", import.meta.url));

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

function makeModel(id: string): DPiRuntimeModelEntry {
	return { id };
}

function makeResolver(models: readonly DPiRuntimeModelEntry[] = []): DPiRuntimeModelResolver {
	return {
		find: (_provider, modelId) => models.find((model) => model.id === modelId),
		getAll: () => models,
	};
}

describe("surface runtime tools source boundaries", () => {
	it("keeps runtime tools independent from extension runtime APIs", async () => {
		const source = await readFile(runtimeToolsPath, "utf8");

		for (const forbidden of ["defineTool", "ExtensionAPI", "ResourceLoader", "ModelRegistry", "HubChannel"]) {
			expect(source).not.toContain(forbidden);
		}
	});

	it("keeps extension adapters from importing or invoking defineTool", async () => {
		const reloadSource = await readFile(reloadToolsPath, "utf8");
		const metadataSource = await readFile(agentMetadataPath, "utf8");

		for (const source of [reloadSource, metadataSource]) {
			expect(source).not.toMatch(/import\s+\{\s*defineTool\b/);
			expect(source).not.toMatch(/\bdefineTool\s*\(/);
		}
	});

	it("creates the three runtime metadata tools", () => {
		const tools = createDPiRuntimeTools({
			reload: {
				runtimeHooks: makeHooks(),
				getSnapshot: () => ({ snapshot: {} }),
			},
			model: {
				runtimeHooks: makeHooks(),
				modelResolver: makeResolver([makeModel("sonnet")]),
			},
			thinking: {
				runtimeHooks: makeHooks(),
				getThinkingLevel: () => "medium",
			},
		});

		expect(tools.map((tool) => tool.name)).toEqual(["reload", "set_model", "set_thinking_level"]);
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

describe("createDPiSetModelTool", () => {
	it("resolves provider/id with the first slash and persists after the hook succeeds", async () => {
		const setModel = vi.fn(async () => {});
		const persistModel = vi.fn();
		const find = vi.fn((provider: string, modelId: string) =>
			provider === "anthropic" && modelId === "claude-sonnet-4/20250514" ? makeModel(modelId) : undefined,
		);
		const resolver: DPiRuntimeModelResolver = {
			find,
			getAll: () => [],
		};
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: resolver,
			persistModel,
		});

		const result = await tool.execute("model-1", { model: "anthropic/claude-sonnet-4/20250514" });

		expect(find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4/20250514");
		expect(setModel).toHaveBeenCalledWith({ modelId: "anthropic/claude-sonnet-4/20250514" });
		expect(persistModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4/20250514");
		expect(isError(result)).toBe(false);
		expect(result.details).toEqual({
			model: "anthropic/claude-sonnet-4/20250514",
			success: true,
			persisted: true,
		});
	});

	it("falls back to bare id search across getAll", async () => {
		const setModel = vi.fn(async () => {});
		const find = vi.fn(() => undefined);
		const getAll = vi.fn(() => [makeModel("bare-model")]);
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: { find, getAll },
		});

		const result = await tool.execute("model-bare", { model: "bare-model" });

		expect(find).not.toHaveBeenCalled();
		expect(getAll).toHaveBeenCalled();
		expect(setModel).toHaveBeenCalledWith({ modelId: "bare-model" });
		expect(isError(result)).toBe(false);
	});

	it("returns isError for an empty model parameter", async () => {
		const setModel = vi.fn(async () => {});
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: makeResolver(),
		});

		const result = await tool.execute("model-empty", { model: "  " });

		expect(isError(result)).toBe(true);
		expect(setModel).not.toHaveBeenCalled();
		expect(resultText(result)).toMatch(/non-empty/i);
	});

	it("returns isError for an unknown model", async () => {
		const setModel = vi.fn(async () => {});
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: makeResolver(),
		});

		const result = await tool.execute("model-unknown", { model: "ghost/model" });

		expect(isError(result)).toBe(true);
		expect(setModel).not.toHaveBeenCalled();
		expect(resultText(result)).toMatch(/Unknown model spec/);
	});

	it("returns isError when the resolver throws", async () => {
		const setModel = vi.fn(async () => {});
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: {
				find: () => {
					throw new Error("bad catalog");
				},
				getAll: () => [],
			},
		});

		const result = await tool.execute("model-resolver-fail", { model: "provider/model" });

		expect(isError(result)).toBe(true);
		expect(setModel).not.toHaveBeenCalled();
		expect(resultText(result)).toContain("bad catalog");
	});

	it("returns isError when the setModel hook throws", async () => {
		const setModel = vi.fn(async () => {
			throw new Error("no credentials");
		});
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: makeResolver([makeModel("bare-model")]),
		});

		const result = await tool.execute("model-hook-fail", { model: "bare-model" });

		expect(isError(result)).toBe(true);
		expect(resultText(result)).toContain("no credentials");
	});

	it("reports failed persistence without marking the tool as error after a successful hook", async () => {
		const setModel = vi.fn(async () => {});
		const onPersistError = vi.fn();
		const tool = createDPiSetModelTool({
			runtimeHooks: makeHooks({ setModel }),
			modelResolver: makeResolver([makeModel("bare-model")]),
			persistModel: () => {
				throw new Error("disk read-only");
			},
			onPersistError,
		});

		const result = await tool.execute("model-persist-fail", { model: "bare-model" });

		expect(isError(result)).toBe(false);
		expect(resultText(result)).toMatch(/Model switched to bare-model/);
		expect(resultText(result)).not.toContain("Persisted to agent.ts");
		expect(resultText(result)).toContain("not persisted to agent.ts");
		expect(result.details).toEqual({
			model: "bare-model",
			success: true,
			persisted: false,
			persistError: "disk read-only",
		});
		expect(onPersistError).toHaveBeenCalledWith("Failed to persist model='bare-model' to agent.ts: disk read-only");
	});
});

describe("createDPiSetThinkingLevelTool", () => {
	it("sets a valid level and returns the effective level", async () => {
		const setThinkingLevel = vi.fn(async () => {});
		const getThinkingLevel = vi.fn((): ThinkingLevel => "high");
		const tool = createDPiSetThinkingLevelTool({
			runtimeHooks: makeHooks({ setThinkingLevel }),
			getThinkingLevel,
		});

		const result = await tool.execute("thinking-1", { level: "medium" });

		expect(setThinkingLevel).toHaveBeenCalledWith({ level: "medium" });
		expect(getThinkingLevel).toHaveBeenCalled();
		expect(isError(result)).toBe(false);
		expect(result.details).toEqual({ requested: "medium", effective: "high" });
	});

	it("returns isError for an invalid level", async () => {
		const setThinkingLevel = vi.fn(async () => {});
		const tool = createDPiSetThinkingLevelTool({
			runtimeHooks: makeHooks({ setThinkingLevel }),
			getThinkingLevel: () => "medium",
		});

		const result = await tool.execute("thinking-invalid", { level: "extreme" });

		expect(isError(result)).toBe(true);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(resultText(result)).toMatch(/off, minimal, low, medium, high, xhigh/);
	});
});
