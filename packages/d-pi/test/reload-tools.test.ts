import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ResourceLoader, ToolDefinition } from "../src/extension/contracts.ts";
import { createReloadExtension, createReloadTools } from "../src/extension/reload-tools.ts";

/**
 * Build a minimal ResourceLoader stub that returns canned values for the four
 * read-only accessors the reload tool queries. Anything else throws so the
 * test fails loudly if the tool starts touching new state.
 */
function makeMockResourceLoader(opts: {
	skills?: Array<{ name: string; filePath?: string }>;
	systemPrompt?: string | undefined;
	appendSystemPrompt?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
}): ResourceLoader {
	const skills = (opts.skills ?? []).map((s) => ({
		name: s.name,
		filePath: s.filePath ?? `/skills/${s.name}/SKILL.md`,
	}));
	const contextFiles = opts.contextFiles ?? [];
	return {
		getSkills: () => ({ skills: skills as never, diagnostics: [] }),
		getSystemPrompt: () => opts.systemPrompt,
		getAppendSystemPrompt: () => opts.appendSystemPrompt ?? [],
		getAgentsFiles: () => ({ agentsFiles: contextFiles }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: {} as never }),
		extendResources: vi.fn(),
		reload: vi.fn().mockResolvedValue(undefined),
	} as unknown as ResourceLoader;
}

interface FakeCtx {
	hasUI: boolean;
	cwd: string;
}

function makeCtx(): FakeCtx {
	return { hasUI: false, cwd: "/tmp" };
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

// AgentToolResult does not expose `isError` directly — that flag is
// surfaced via the ToolResultMessage by the runtime — but our tools do
// return it. This helper narrows the test-side access without a cast
// in every assertion.
function isError(result: ToolResult): boolean {
	return Boolean((result as { isError?: boolean }).isError);
}

function resultText(result: ToolResult): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

describe("createReloadTools", () => {
	let mockReloadFn: ReturnType<typeof vi.fn>;
	let mockLoader: ResourceLoader;

	beforeEach(() => {
		mockReloadFn = vi.fn().mockResolvedValue(undefined);
		mockLoader = makeMockResourceLoader({
			skills: [{ name: "skill-a" }, { name: "skill-b" }],
			systemPrompt: "base system prompt",
			appendSystemPrompt: ["append block 1"],
			contextFiles: [{ path: "/work/AGENTS.md", content: "agents content" }],
		});
	});

	it("exports a tool named 'reload' with description and zero-arg schema", () => {
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => mockLoader,
		});
		expect(tool.name).toBe("reload");
		expect(tool.label).toBeTruthy();
		expect(tool.description).toMatch(/reload/i);
		// 0 parameters: schema is Type.Object({}) which renders as a fixed object
		// with no required properties.
		const params = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params.properties ?? {}).toEqual({});
		expect(params.required ?? []).toEqual([]);
	});

	it("execute() calls the reload function then reports fresh resource state", async () => {
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => mockLoader,
		});
		const result = await tool.execute("call-1", {}, undefined, undefined, makeCtx() as never);
		expect(mockReloadFn).toHaveBeenCalledTimes(1);
		expect(isError(result)).toBe(false);
		const parsed = JSON.parse(resultText(result)) as {
			skills: number;
			skillNames: string[];
			systemPromptLen: number;
			appendSystemPromptCount: number;
			contextFiles: number;
			contextFilePaths: string[];
		};
		expect(parsed.skills).toBe(2);
		expect(parsed.skillNames).toEqual(["skill-a", "skill-b"]);
		expect(parsed.systemPromptLen).toBe("base system prompt".length);
		expect(parsed.appendSystemPromptCount).toBe(1);
		expect(parsed.contextFiles).toBe(1);
		expect(parsed.contextFilePaths).toEqual(["/work/AGENTS.md"]);
		expect(result.details).toEqual({
			skills: 2,
			systemPromptLen: "base system prompt".length,
			contextFiles: 1,
		});
	});

	it("execute() returns isError when getReloadFn resolves to undefined (session not yet ready)", async () => {
		const tool = createReloadTools({
			getReloadFn: () => undefined,
			getResourceLoader: () => mockLoader,
		});
		const result = await tool.execute("call-2", {}, undefined, undefined, makeCtx() as never);
		expect(isError(result)).toBe(true);
		expect(resultText(result)).toMatch(/not available/i);
		expect(mockReloadFn).not.toHaveBeenCalled();
	});

	it("execute() returns isError when getResourceLoader resolves to undefined (post-reload)", async () => {
		// The reload function is called first; the resource loader is
		// re-resolved after reload returns. If the session no longer exposes
		// a resource loader (e.g. the AgentSession was torn down between
		// reload completion and snapshot read), we still return an error.
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => undefined,
		});
		const result = await tool.execute("call-3", {}, undefined, undefined, makeCtx() as never);
		expect(isError(result)).toBe(true);
		expect(resultText(result)).toMatch(/no longer available/i);
		// Reload was attempted, then the post-reload loader lookup failed.
		expect(mockReloadFn).toHaveBeenCalledTimes(1);
	});

	it("execute() returns isError when the reload function throws", async () => {
		const failingReload = vi.fn().mockRejectedValue(new Error("reload boom"));
		const tool = createReloadTools({
			getReloadFn: () => failingReload,
			getResourceLoader: () => mockLoader,
		});
		const result = await tool.execute("call-4", {}, undefined, undefined, makeCtx() as never);
		expect(isError(result)).toBe(true);
		expect(resultText(result)).toContain("reload boom");
	});

	it("execute() reports state observed AFTER reload, not before", async () => {
		// Simulate that between two consecutive calls the loader has been
		// "reloaded" and now reports a different skill set.
		let currentSkills = [{ name: "old-skill" }];
		const liveLoader = makeMockResourceLoader({ skills: currentSkills });
		const reloadFn = vi.fn().mockImplementation(async () => {
			currentSkills = [{ name: "new-skill-1" }, { name: "new-skill-2" }];
		});
		const tool = createReloadTools({
			getReloadFn: () => reloadFn,
			// The getter returns the same loader object, but the loader's
			// underlying skills are read fresh on every call.
			getResourceLoader: () =>
				makeMockResourceLoader({
					skills: currentSkills,
					systemPrompt: "post-reload prompt",
				}),
		});
		const result = await tool.execute("call-5", {}, undefined, undefined, makeCtx() as never);
		const parsed = JSON.parse(resultText(result)) as {
			skills: number;
			skillNames: string[];
			systemPromptLen: number;
		};
		expect(parsed.skills).toBe(2);
		expect(parsed.skillNames).toEqual(["new-skill-1", "new-skill-2"]);
		expect(parsed.systemPromptLen).toBe("post-reload prompt".length);
		// the unused liveLoader is referenced to keep the test fixture honest
		expect(liveLoader).toBeDefined();
	});
});

describe("createReloadExtension", () => {
	it("registers a single reload tool on the pi api", () => {
		const registered: ToolDefinition[] = [];
		const fakeApi = {
			registerTool: (t: ToolDefinition) => registered.push(t),
		} as unknown as ExtensionAPI;
		const factory = createReloadExtension({
			getReloadFn: () => async () => {},
			getResourceLoader: () => makeMockResourceLoader({}),
		});
		factory(fakeApi);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe("reload");
	});

	it("is safe to call before the session is ready (tool still registered)", () => {
		// The worker constructs the extension factory at a point where
		// `runtime.session` is still undefined. The factory must still
		// register the tool — the tool itself is responsible for the
		// "session not ready" error path inside execute().
		const registered: ToolDefinition[] = [];
		const fakeApi = {
			registerTool: (t: ToolDefinition) => registered.push(t),
		} as unknown as ExtensionAPI;
		const factory = createReloadExtension({
			getReloadFn: () => undefined,
			getResourceLoader: () => undefined,
		});
		expect(() => factory(fakeApi)).not.toThrow();
		expect(registered).toHaveLength(1);
	});
});

describe("agent-worker integration (mock session.reload)", () => {
	// Mirrors the inline wiring shape used in
	// packages/d-pi/src/worker/agent-worker.ts: the extension factory is
	// constructed with getters that lazily look up runtime.session.
	interface MockRuntime {
		session?: {
			reload: () => Promise<void>;
			resourceLoader: ResourceLoader;
		};
	}

	function buildWorkerFactory(getRuntime: () => MockRuntime | undefined) {
		return createReloadExtension({
			getReloadFn: () => {
				const session = getRuntime()?.session;
				return session ? () => session.reload() : undefined;
			},
			getResourceLoader: () => getRuntime()?.session?.resourceLoader,
		});
	}

	it("returns isError before session is set, and reloads successfully after session is set", async () => {
		let runtime: MockRuntime | undefined;
		const factory = buildWorkerFactory(() => runtime);
		const registered: ToolDefinition[] = [];
		const fakeApi = {
			registerTool: (t: ToolDefinition) => registered.push(t),
		} as unknown as ExtensionAPI;
		factory(fakeApi);
		const tool = registered[0]!;

		// Phase 1: no session yet (mirrors createAgentSessionServices calling
		// the factory before the AgentSession is built).
		const earlyResult = await tool.execute("c-early", {}, undefined, undefined, makeCtx() as never);
		expect(isError(earlyResult)).toBe(true);

		// Phase 2: session is now available. The mock loader is the SAME
		// object before and after reload (matching real AgentSession.reload
		// which mutates the resourceLoader in place). The reload spy
		// mutates the loader's internal `getSkills()` return value to
		// simulate fresh state.
		const liveSkills: Array<{ name: string }> = [{ name: "pre-reload-skill" }];
		const livePrompt: { value: string } = { value: "pre-reload system prompt" };
		const liveLoader = makeMockResourceLoader({
			skills: liveSkills,
			systemPrompt: livePrompt.value,
		});
		// Override getSkills / getSystemPrompt on the live loader so the
		// spy can mutate `liveSkills` / `livePrompt` and the snapshot picks
		// up the new values.
		(liveLoader as unknown as { getSkills: () => { skills: Array<{ name: string }> } }).getSkills = () => ({
			skills: liveSkills as never,
			diagnostics: [],
		});
		(liveLoader as unknown as { getSystemPrompt: () => string | undefined }).getSystemPrompt = () => livePrompt.value;

		const reloadSpy = vi.fn().mockImplementation(async () => {
			liveSkills.length = 0;
			liveSkills.push({ name: "post-reload-skill-1" }, { name: "post-reload-skill-2" });
			livePrompt.value = "post-reload system prompt";
		});
		runtime = {
			session: {
				reload: reloadSpy,
				resourceLoader: liveLoader,
			},
		};

		const result = await tool.execute("c-real", {}, undefined, undefined, makeCtx() as never);
		expect(reloadSpy).toHaveBeenCalledTimes(1);
		expect(isError(result)).toBe(false);
		const parsed = JSON.parse(resultText(result)) as {
			skillNames: string[];
			systemPromptLen: number;
		};
		expect(parsed.skillNames).toEqual(["post-reload-skill-1", "post-reload-skill-2"]);
		expect(parsed.systemPromptLen).toBe("post-reload system prompt".length);
	});
});

/**
 * Build a minimal ModelRegistry stub for the new getModelRegistry dep.
 * Only exposes refresh() + getAll() — the only methods the reload
 * tool touches.
 */
interface MockModelRegistry {
	refresh: ReturnType<typeof vi.fn>;
	getAll: ReturnType<typeof vi.fn>;
	getError: ReturnType<typeof vi.fn>;
}
function makeMockModelRegistry(modelCount: number): MockModelRegistry {
	return {
		refresh: vi.fn(),
		getAll: vi.fn().mockReturnValue(new Array(modelCount)),
		getError: vi.fn().mockReturnValue(undefined),
	};
}

describe("createReloadTools — getModelRegistry dep (Bug 1: models.json reload)", () => {
	let mockReloadFn: ReturnType<typeof vi.fn>;
	let mockLoader: ResourceLoader;

	beforeEach(() => {
		mockReloadFn = vi.fn().mockResolvedValue(undefined);
		mockLoader = makeMockResourceLoader({});
	});

	it("calls modelRegistry.refresh() once and reports models count in snapshot when getModelRegistry is provided", async () => {
		const mockRegistry = makeMockModelRegistry(42);
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => mockLoader,
			getModelRegistry: () => mockRegistry as never,
		});
		const result = await tool.execute("c-reg-1", {}, undefined, undefined, makeCtx() as never);
		expect(mockRegistry.refresh).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(resultText(result)) as { models?: number; modelsError?: string };
		expect(parsed.models).toBe(42);
		expect(parsed.modelsError).toBeUndefined();
	});

	it("does NOT call modelRegistry when getModelRegistry is omitted (backward compat)", async () => {
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => mockLoader,
		});
		const result = await tool.execute("c-reg-2", {}, undefined, undefined, makeCtx() as never);
		const parsed = JSON.parse(resultText(result)) as { models?: number; modelsError?: string };
		expect(parsed.models).toBeUndefined();
		expect(parsed.modelsError).toBeUndefined();
	});

	it("does NOT call modelRegistry when getModelRegistry returns undefined", async () => {
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => mockLoader,
			getModelRegistry: () => undefined,
		});
		const result = await tool.execute("c-reg-3", {}, undefined, undefined, makeCtx() as never);
		const parsed = JSON.parse(resultText(result)) as { models?: number; modelsError?: string };
		expect(parsed.models).toBeUndefined();
		expect(parsed.modelsError).toBeUndefined();
	});

	it("reports modelsError in snapshot when modelRegistry.refresh() throws (bad models.json)", async () => {
		const failingRegistry = makeMockModelRegistry(0);
		failingRegistry.refresh.mockImplementation(() => {
			throw new Error("invalid models.json schema");
		});
		const tool = createReloadTools({
			getReloadFn: () => mockReloadFn,
			getResourceLoader: () => mockLoader,
			getModelRegistry: () => failingRegistry as never,
		});
		const result = await tool.execute("c-reg-4", {}, undefined, undefined, makeCtx() as never);
		// The reload itself succeeded (resources refreshed); only the
		// models.json refresh failed. The snapshot surfaces the error
		// without marking the whole call as isError, because the
		// resource side still worked.
		expect(isError(result)).toBe(false);
		const parsed = JSON.parse(resultText(result)) as { models?: number; modelsError?: string };
		expect(parsed.models).toBeUndefined();
		expect(parsed.modelsError).toMatch(/invalid models\.json schema/);
	});
});
