import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ModelRegistry, ResourceLoader, ToolDefinition } from "@sheason/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentConfigFromTs } from "../src/agent-config.ts";
import { createAgentMetadataExtension } from "../src/extension/agent-metadata.ts";

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

function isError(result: ToolResult): boolean {
	return Boolean((result as { isError?: boolean }).isError);
}

function resultText(result: ToolResult): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

function makeMockResourceLoader(): ResourceLoader {
	return {
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: {} as never }),
		extendResources: vi.fn(),
		reload: vi.fn().mockResolvedValue(undefined),
	} as unknown as ResourceLoader;
}

interface FakeCtx {
	hasUI?: boolean;
	cwd: string;
	modelRegistry?: ModelRegistry;
}

function makeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx {
	return { cwd: "/tmp", ...overrides } as FakeCtx;
}

describe("createAgentMetadataExtension — set_model + set_thinking_level (P0 coverage)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(os.tmpdir(), "d-pi-agent-meta-"));
		// Seed a minimal agent.ts so the persist path has something to update.
		writeFileSync(
			join(tmpDir, "agent.ts"),
			[
				'import { defineAgent, defineContextFile, defineModel, defineSkill, defineTool } from "@sheason/d-pi";',
				"",
				"export default defineAgent({",
				'\tdescription: "test-agent",',
				'\tmodel: defineModel({ provider: "unknown", name: "old-model" }),',
				'\tskills: defineSkill({ dir: "./skills" }),',
				"\ttools: [",
				'\t\tdefineTool({ name: "dispatch_read" }),',
				"\t],",
				"\tcontextFiles: [",
				'\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),',
				'\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),',
				"\t],",
				"});",
				"",
			].join("\n"),
		);
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best effort cleanup
		}
	});

	function makeMockRegistry(findResult?: any, allResult: any[] = []) {
		return {
			find: vi.fn().mockReturnValue(findResult),
			getAll: vi.fn().mockReturnValue(allResult),
		} as unknown as ModelRegistry;
	}

	it("registers reload, set_model and set_thinking_level on the ExtensionAPI", () => {
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: ToolDefinition) => registered.push(t),
			setModel: vi.fn(),
			getThinkingLevel: vi.fn().mockReturnValue("medium"),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => makeMockRegistry(),
			getAgentCwd: () => tmpDir,
		});
		factory(fakePi);

		const names = registered.map((t) => t.name);
		expect(names).toContain("reload");
		expect(names).toContain("set_model");
		expect(names).toContain("set_thinking_level");
	});

	it("set_model success path resolves via provider/id, calls setModel, writes agent.ts and returns success (no isError)", async () => {
		const target = { id: "claude-sonnet-4", provider: "anthropic" } as any;
		const mockRegistry = makeMockRegistry(target);
		const fakeSetModel = vi.fn().mockResolvedValue(true);

		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: ToolDefinition) => registered.push(t),
			setModel: fakeSetModel,
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => mockRegistry,
			getAgentCwd: () => tmpDir,
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_model")!;
		const ctx = makeCtx({ cwd: "/wrong/cwd", modelRegistry: mockRegistry });
		const result = await tool.execute(
			"c-1",
			{ model: "anthropic/claude-sonnet-4" },
			undefined,
			undefined,
			ctx as never,
		);

		expect(fakeSetModel).toHaveBeenCalledWith(target);
		expect(isError(result)).toBe(false);
		expect(resultText(result)).toMatch(/Model switched to anthropic\/claude-sonnet-4/);

		// Verify the write used the getAgentCwd (tmpDir) not the ctx.cwd
		const written = readAgentConfigFromTs(tmpDir);
		expect(written?.model).toBe("anthropic/claude-sonnet-4");
	});

	it("set_model with model id containing '/' (e.g. versioned) uses first-slash split and still resolves", async () => {
		const target = { id: "claude-sonnet-4/20250514", provider: "anthropic" } as any;
		const findMock = vi.fn((p: string, id: string) => {
			if (p === "anthropic" && id === "claude-sonnet-4/20250514") return target;
			return undefined;
		});
		const mockRegistry = { find: findMock, getAll: vi.fn().mockReturnValue([]) } as unknown as ModelRegistry;

		const fakeSetModel = vi.fn().mockResolvedValue(true);
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: any) => registered.push(t),
			setModel: fakeSetModel,
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => mockRegistry,
			getAgentCwd: () => tmpDir,
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_model")!;
		const result = await tool.execute(
			"c-slash",
			{ model: "anthropic/claude-sonnet-4/20250514" },
			undefined,
			undefined,
			makeCtx({ modelRegistry: mockRegistry }) as never,
		);

		expect(findMock).toHaveBeenCalledWith("anthropic", "claude-sonnet-4/20250514");
		expect(isError(result)).toBe(false);
	});

	it("set_model falls back to bare-id search across getAll() when no provider/ prefix", async () => {
		const target = { id: "some-bare-model" } as any;
		const mockRegistry = makeMockRegistry(undefined, [target]);
		const fakeSetModel = vi.fn().mockResolvedValue(true);
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: any) => registered.push(t),
			setModel: fakeSetModel,
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => mockRegistry,
			getAgentCwd: () => tmpDir,
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_model")!;
		const result = await tool.execute(
			"c-bare",
			{ model: "some-bare-model" },
			undefined,
			undefined,
			makeCtx({ modelRegistry: mockRegistry }) as never,
		);

		expect(mockRegistry.getAll).toHaveBeenCalled();
		expect(isError(result)).toBe(false);
	});

	it("set_model returns isError when spec is unknown (no match in registry)", async () => {
		const mockRegistry = makeMockRegistry(undefined, []);
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: any) => registered.push(t),
			setModel: vi.fn(),
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => mockRegistry,
			getAgentCwd: () => tmpDir,
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_model")!;
		const result = await tool.execute(
			"c-unknown",
			{ model: "ghost/model" },
			undefined,
			undefined,
			makeCtx({ modelRegistry: mockRegistry }) as never,
		);

		expect(isError(result)).toBe(true);
		expect(resultText(result)).toMatch(/Unknown model spec/);
	});

	it("set_model returns isError (and does not write) when setModel returns false (no credentials)", async () => {
		const target = { id: "no-creds" } as any;
		// Use bare-id fallback path: provide via getAll so the spec resolves, then setModel can return false.
		const mockRegistry = makeMockRegistry(undefined, [target]);
		const fakeSetModel = vi.fn().mockResolvedValue(false);
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: any) => registered.push(t),
			setModel: fakeSetModel,
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => mockRegistry,
			getAgentCwd: () => tmpDir,
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_model")!;
		const result = await tool.execute(
			"c-fail",
			{ model: "no-creds" },
			undefined,
			undefined,
			makeCtx({ modelRegistry: mockRegistry }) as never,
		);

		expect(isError(result)).toBe(true); // review P1 #6: failure to activate must be isError
		expect(resultText(result)).toMatch(/reported failure/);
		// file should still have the original model (write only happens on success===true)
		const written = readAgentConfigFromTs(tmpDir);
		expect(written?.model).toBe("unknown/old-model");
	});

	it("set_thinking_level accepts a valid level, calls setThinkingLevel and returns effective value (no isError)", async () => {
		const fakeSetTL = vi.fn();
		const fakeGetTL = vi.fn().mockReturnValue("high");
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: any) => registered.push(t),
			setModel: vi.fn(),
			getThinkingLevel: fakeGetTL,
			setThinkingLevel: fakeSetTL,
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => makeMockRegistry(),
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_thinking_level")!;
		const result = await tool.execute("tl-1", { level: "high" }, undefined, undefined, makeCtx() as never);

		expect(fakeSetTL).toHaveBeenCalledWith("high");
		expect(isError(result)).toBe(false);
		expect(resultText(result)).toMatch(/Requested='high', effective='high'/);
	});

	it("set_thinking_level returns isError + clear message for invalid level (schema + runtime both protect)", async () => {
		const registered: ToolDefinition[] = [];
		const fakePi = {
			registerTool: (t: any) => registered.push(t),
			setModel: vi.fn(),
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
		} as unknown as ExtensionAPI;

		const factory = createAgentMetadataExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => makeMockResourceLoader(),
			getModelRegistry: () => makeMockRegistry(),
		});
		factory(fakePi);

		const tool = registered.find((t) => t.name === "set_thinking_level")!;
		const result = await tool.execute("tl-bad", { level: "insane" }, undefined, undefined, makeCtx() as never);

		expect(isError(result)).toBe(true);
		expect(resultText(result)).toMatch(/Invalid thinking level 'insane'/);
		expect(resultText(result)).toMatch(/off, minimal, low, medium, high, xhigh/);
	});
});
