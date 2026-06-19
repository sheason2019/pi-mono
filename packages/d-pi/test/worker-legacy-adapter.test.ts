import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/extension/contracts.ts";
import {
	createDPiAgentSessionFromServices,
	createDPiAgentSessionRuntime,
	createDPiAgentSessionServices,
	createDPiSessionManager,
	createDPiWorkerInfrastructure,
	DPiAgentIpcServer,
	type DPiAgentSessionRuntime,
	type DPiAgentSessionServices,
	type DPiIpcMessageHandlers,
	type DPiIpcTransport,
	DPiLocalAgentSessionProxy,
	type DPiWorkerSession,
	generateDPiBanner,
	resolveDPiInitialModel,
	runtimeModelSpecFromResolvedModel,
} from "../src/worker/coding-agent-worker-adapter.ts";

type InitialModelOptions = Parameters<typeof resolveDPiInitialModel>[0];
type WorkerModelRegistry = InitialModelOptions["modelRegistry"];
type WorkerSettingsManager = InitialModelOptions["settingsManager"];
type DefaultThinkingLevel = ReturnType<WorkerSettingsManager["getDefaultThinkingLevel"]>;

interface MinimalModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable(): Promise<Model<Api>[]>;
}

interface MinimalSettingsManager {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	getDefaultThinkingLevel(): DefaultThinkingLevel;
}

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1,
		maxTokens: 1,
	};
}

function asWorkerModelRegistry(registry: MinimalModelRegistry): WorkerModelRegistry {
	return registry as unknown as WorkerModelRegistry;
}

function makeModelRegistry(options: {
	find?: (provider: string, modelId: string) => Model<Api> | undefined;
	all?: Model<Api>[];
	available?: Model<Api>[];
}): MinimalModelRegistry {
	return {
		find: vi.fn(options.find ?? (() => undefined)),
		getAll: vi.fn(() => options.all ?? []),
		getAvailable: vi.fn(async () => options.available ?? []),
	};
}

function asWorkerSettingsManager(settingsManager: MinimalSettingsManager): WorkerSettingsManager {
	return settingsManager as unknown as WorkerSettingsManager;
}

function makeSettingsManager(
	options: { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: DefaultThinkingLevel } = {},
): MinimalSettingsManager {
	return {
		getDefaultProvider: vi.fn(() => options.defaultProvider),
		getDefaultModel: vi.fn(() => options.defaultModel),
		getDefaultThinkingLevel: vi.fn(() => options.defaultThinkingLevel),
	};
}

interface CapturedHttpResponse {
	requestId: string;
	status: number;
	body: unknown;
}

interface CapturedSseEvent {
	subscriberId: string;
	event: string;
	data: unknown;
}

interface MemoryTransport extends DPiIpcTransport {
	emit(message: unknown): void;
}

interface IpcHarness {
	transport: MemoryTransport;
	server: DPiAgentIpcServer;
	responses: CapturedHttpResponse[];
	events: CapturedSseEvent[];
}

interface TestSession extends DPiWorkerSession {
	readonly testSessionId: string;
}

function createMemoryTransport(): MemoryTransport {
	let handler: ((message: unknown) => void) | undefined;
	return {
		postMessage: vi.fn(),
		onMessage(nextHandler) {
			handler = nextHandler;
		},
		emit(message) {
			handler?.(message);
		},
	};
}

function createIpcHarness(proxy: DPiLocalAgentSessionProxy): IpcHarness {
	const transport = createMemoryTransport();
	const responses: CapturedHttpResponse[] = [];
	const events: CapturedSseEvent[] = [];
	const handlers: DPiIpcMessageHandlers = {
		onHttpResponse(requestId, status, body) {
			responses.push({ requestId, status, body });
		},
		onSseEvent(subscriberId, event, data) {
			events.push({ subscriberId, event, data });
		},
	};
	const server = new DPiAgentIpcServer(proxy, transport, handlers);
	server.start();
	return { transport, server, responses, events };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > 1000) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function isExtensionInputMessage(data: unknown): boolean {
	if (typeof data !== "object" || data === null || !("customType" in data) || !("content" in data)) {
		return false;
	}
	const message = data as {
		customType?: unknown;
		content?: unknown;
		details?: unknown;
	};
	return (
		message.customType === "extension-input" &&
		Array.isArray(message.content) &&
		message.content.some(
			(part) =>
				typeof part === "object" &&
				part !== null &&
				"text" in part &&
				part.text === "extension handled: ping extension",
		) &&
		typeof message.details === "object" &&
		message.details !== null &&
		"source" in message.details &&
		message.details.source === "programmatic"
	);
}

async function queryIpc(harness: IpcHarness, requestId: string, query: string): Promise<CapturedHttpResponse> {
	harness.transport.emit({ type: "http_query", requestId, query });
	await waitFor(() => harness.responses.some((response) => response.requestId === requestId));
	const response = harness.responses.find((candidate) => candidate.requestId === requestId);
	if (!response) {
		throw new Error(`Missing response for ${requestId}`);
	}
	return response;
}

async function requestIpc(
	harness: IpcHarness,
	requestId: string,
	action: string,
	data: unknown,
): Promise<CapturedHttpResponse> {
	harness.transport.emit({ type: "http_request", requestId, action, data });
	await waitFor(() => harness.responses.some((response) => response.requestId === requestId));
	const response = harness.responses.find((candidate) => candidate.requestId === requestId);
	if (!response) {
		throw new Error(`Missing response for ${requestId}`);
	}
	return response;
}

function makeBindOptions(): Parameters<DPiWorkerSession["bindExtensions"]>[0] {
	return {
		commandContextActions: {
			waitForIdle: async () => {},
			newSession: async (options?: unknown) => options,
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async (sessionPath: string, options?: unknown) => ({ sessionPath, options }),
			reload: async () => {},
		},
		abortHandler: () => {},
		onError: () => {},
	};
}

function createTestSession(testSessionId: string, overrides: Partial<TestSession> = {}): TestSession {
	const resourceLoader = {
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
		extendResources: () => {},
		reload: vi.fn(async () => {}),
		...overrides.resourceLoader,
	};
	return {
		testSessionId,
		agent: {
			waitForIdle: vi.fn(async () => {}),
		},
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getAvailable: async () => [],
			refresh: () => {},
		},
		getToolDefinitions: vi.fn(() => []),
		reload: vi.fn(async () => {
			await resourceLoader.reload();
		}),
		bindExtensions: vi.fn(async () => {}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		...overrides,
		resourceLoader,
	};
}

function createTestRuntime(session: DPiWorkerSession = createTestSession("initial")): DPiAgentSessionRuntime {
	return {
		session,
		newSession: vi.fn(async (options?: unknown) => options),
		fork: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async (sessionPath: string, options?: unknown) => ({ sessionPath, options })),
		setBeforeSessionInvalidate: vi.fn(),
		setRebindSession: vi.fn(),
	};
}

describe("worker runtime adapter", () => {
	it("keeps agent-worker source independent from previous runtime package names", async () => {
		const source = await readFile(new URL("../src/worker/agent-worker.ts", import.meta.url), "utf8");

		expect(source).not.toContain("DPiLegacy");
	});

	it("keeps worker sources on the d-pi-owned adapter surface", async () => {
		const workerDir = fileURLToPath(new URL("../src/worker/", import.meta.url));
		const entries = await readdir(workerDir);
		const sourceFiles = entries.filter((entry) => entry.endsWith(".ts"));
		const filesWithPreviousSurfaceNames: string[] = [];

		for (const fileName of sourceFiles) {
			const source = await readFile(new URL(`../src/worker/${fileName}`, import.meta.url), "utf8");
			if (source.includes("DPiLegacy")) {
				filesWithPreviousSurfaceNames.push(basename(fileName));
			}
		}

		expect(filesWithPreviousSurfaceNames.sort()).toEqual([]);
	});

	it("exports the d-pi-named worker adapter surface", () => {
		expect(createDPiWorkerInfrastructure).toEqual(expect.any(Function));
		expect(createDPiSessionManager).toEqual(expect.any(Function));
		expect(createDPiAgentSessionServices).toEqual(expect.any(Function));
		expect(createDPiAgentSessionFromServices).toEqual(expect.any(Function));
		expect(createDPiAgentSessionRuntime).toEqual(expect.any(Function));
		expect(resolveDPiInitialModel).toEqual(expect.any(Function));
		expect(generateDPiBanner).toEqual(expect.any(Function));
		expect(DPiAgentIpcServer).toEqual(expect.any(Function));
		expect(DPiLocalAgentSessionProxy).toEqual(expect.any(Function));
	});

	it("loads pi-compatible settings and built-in models for worker infrastructure", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "d-pi-pi-settings-"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "stepfun", defaultModel: "step-3.7-flash" }),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const infrastructure = createDPiWorkerInfrastructure("/tmp/d-pi-worker-infra");

			expect(infrastructure.settingsManager.getDefaultProvider()).toBe("stepfun");
			expect(infrastructure.settingsManager.getDefaultModel()).toBe("step-3.7-flash");
			expect(infrastructure.modelRegistry.getAll().length).toBeGreaterThan(0);
			expect(infrastructure.modelRegistry.find("stepfun", "step-3.7-flash")?.id).toBe("stepfun/step-3.7-flash");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("generates a native pi-compatible startup banner from session resources", () => {
		const session = createTestSession("banner", {
			resourceLoader: {
				...createTestSession("base").resourceLoader,
				getAgentsFiles: () => ({
					agentsFiles: [
						{ path: "~/workspace/AGENTS.md", content: "workspace" },
						{ path: "~/workspace/project/AGENTS.md", content: "project" },
					],
				}),
				getSkills: () => ({
					skills: [
						{ name: "tmux", filePath: "~/.claude/skills/tmux/SKILL.md" },
						{ name: "using-superpowers", filePath: "~/.agents/skills/superpowers/using-superpowers/SKILL.md" },
					],
					diagnostics: [
						{
							type: "collision",
							message: "skill collision",
							collision: {
								resourceType: "skill",
								name: "using-superpowers",
								winnerPath: "~/.agents/skills/superpowers/using-superpowers/SKILL.md",
								loserPath: "~/.agents/skills/using-superpowers/SKILL.md",
								winnerSource: "user",
							},
						},
					],
				}),
			},
		});

		const banner = generateDPiBanner(session);

		expect(banner.appName).toBe("pi");
		expect(banner.compactHints.map((hint) => `${hint.key} ${hint.description}`).join(" · ")).toBe(
			"escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
		);
		expect(banner.expandedHints.map((hint) => `${hint.key} ${hint.description}`)).toEqual([
			"escape to interrupt",
			"ctrl+c to clear",
			"ctrl+c twice to exit",
			"ctrl+d to exit (empty)",
			"ctrl+z to suspend",
			"ctrl+k to delete to end",
			"shift+tab to cycle thinking level",
			"ctrl+p/shift+ctrl+p to cycle models",
			"ctrl+l to select model",
			"ctrl+o to expand tools",
			"ctrl+t to expand thinking",
			"ctrl+g for external editor",
			"/ for commands",
			"! to run bash",
			"!! to run bash (no context)",
			"alt+enter to queue follow-up",
			"alt+up to edit all queued messages",
			"ctrl+v to paste image",
			"drop files to attach",
		]);
		expect(banner.compactOnboarding).toBe("Press ctrl+o to show full startup help and loaded resources.");
		expect(banner.onboarding).toBe(
			"Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
		);
		expect(banner.loadedResources).toEqual([
			{
				name: "Context",
				compactList: "~/workspace/AGENTS.md, ~/workspace/project/AGENTS.md",
				expandedList: "~/workspace/AGENTS.md\n~/workspace/project/AGENTS.md",
			},
			{
				name: "Skills",
				compactList: "tmux, using-superpowers",
				expandedList: "~/.claude/skills/tmux/SKILL.md\n~/.agents/skills/superpowers/using-superpowers/SKILL.md",
			},
		]);
		expect(banner.diagnostics).toEqual([
			{
				label: "Skill conflicts",
				entries: [
					expect.objectContaining({
						type: "collision",
						collision: expect.objectContaining({
							name: "using-superpowers",
							winnerPath: "~/.agents/skills/superpowers/using-superpowers/SKILL.md",
							loserPath: "~/.agents/skills/using-superpowers/SKILL.md",
						}),
					}),
				],
			},
		]);
	});

	it("resolves provider/model specs using the first slash as the provider separator", async () => {
		const target = makeModel("openrouter", "openai/gpt-4.1");
		const registry = makeModelRegistry({
			find: (provider, modelId) => (provider === target.provider && modelId === target.id ? target : undefined),
		});

		const result = await resolveDPiInitialModel({
			modelSpec: "openrouter/openai/gpt-4.1",
			modelRegistry: asWorkerModelRegistry(registry),
			settingsManager: asWorkerSettingsManager(makeSettingsManager()),
		});

		expect(result).toBe(target);
		expect(registry.find).toHaveBeenCalledWith("openrouter", "openai/gpt-4.1");
		expect(registry.getAll).not.toHaveBeenCalled();
	});

	it("resolves bare model specs from all models by exact id", async () => {
		const target = makeModel("openrouter", "gpt-4.1");
		const registry = makeModelRegistry({ all: [target] });

		const result = await resolveDPiInitialModel({
			modelSpec: "gpt-4.1",
			modelRegistry: asWorkerModelRegistry(registry),
			settingsManager: asWorkerSettingsManager(makeSettingsManager()),
		});

		expect(result).toBe(target);
		expect(registry.find).not.toHaveBeenCalled();
		expect(registry.getAll).toHaveBeenCalledOnce();
	});

	it("falls back through configured defaults when an explicit provider/model spec is not found", async () => {
		const fallback = makeModel("anthropic", "claude-sonnet");
		const registry = makeModelRegistry({
			find: (provider, modelId) =>
				provider === fallback.provider && modelId === fallback.id ? fallback : undefined,
		});

		const result = await resolveDPiInitialModel({
			modelSpec: "openrouter/missing-model",
			modelRegistry: asWorkerModelRegistry(registry),
			settingsManager: asWorkerSettingsManager(
				makeSettingsManager({
					defaultProvider: fallback.provider,
					defaultModel: fallback.id,
				}),
			),
		});

		expect(result).toBe(fallback);
		expect(registry.find).toHaveBeenNthCalledWith(1, "openrouter", "missing-model");
		expect(registry.find).toHaveBeenNthCalledWith(2, fallback.provider, fallback.id);
	});

	it("uses the resolved default model as the remote-first runtime model spec", () => {
		expect(runtimeModelSpecFromResolvedModel(makeModel("stepfun", "step-3.7-flash"))).toBe("stepfun/step-3.7-flash");
		expect(runtimeModelSpecFromResolvedModel(undefined)).toBeUndefined();
	});

	it("binds extension factories and exposes registered commands and tools in session state", async () => {
		const factory = vi.fn((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "sample_tool",
				label: "Sample Tool",
				description: "A tool registered by a d-pi extension.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.registerCommand("sample", {
				description: "A command registered by a d-pi extension.",
				handler: () => {},
			});
		});
		const services = await createDPiAgentSessionServices({
			cwd: "/tmp/d-pi-extension-bind",
			agentDir: "/tmp/d-pi-extension-bind",
			authStorage: { kind: "d-pi-auth-storage" },
			settingsManager: asWorkerSettingsManager(makeSettingsManager()),
			modelRegistry: asWorkerModelRegistry(makeModelRegistry({})),
			resourceLoaderOptions: {
				extensionFactories: [{ name: "sample-extension", factory }],
			},
		});
		const { session } = await createDPiAgentSessionFromServices({
			services,
			sessionManager: createDPiSessionManager("/tmp/d-pi-extension-bind"),
		});

		await session.bindExtensions(makeBindOptions());

		expect(factory).toHaveBeenCalledOnce();
		const harness = createIpcHarness(new DPiLocalAgentSessionProxy(createTestRuntime(session)));
		try {
			const commands = await queryIpc(harness, "commands-1", "commands");
			expect(commands.status).toBe(200);
			expect(commands.body).toContainEqual({ name: "settings", source: "builtin" });
			expect(commands.body).toContainEqual({
				name: "sample",
				description: "A command registered by a d-pi extension.",
				source: "extension",
			});

			const state = await queryIpc(harness, "state-1", "state");
			expect(state.status).toBe(200);
			expect(state.body).toMatchObject({
				extensions: {
					tools: [expect.objectContaining({ name: "sample_tool", label: "Sample Tool" })],
					commands: [expect.objectContaining({ name: "sample" })],
				},
			});
		} finally {
			harness.server.stop();
		}
	});

	it("exposes bound extension tool definitions for the remote-first AgentHarness", async () => {
		const factory = vi.fn((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "dispatch_bash",
				label: "Dispatch bash",
				description: "Run bash through dispatch",
				parameters: Type.Object({
					command: Type.String(),
				}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		});
		const services = await createDPiAgentSessionServices({
			cwd: "/tmp/d-pi-harness-tools",
			agentDir: "/tmp/d-pi-harness-tools",
			authStorage: { kind: "d-pi-auth-storage" },
			settingsManager: asWorkerSettingsManager(makeSettingsManager()),
			modelRegistry: asWorkerModelRegistry(makeModelRegistry({})),
			resourceLoaderOptions: {
				extensionFactories: [{ name: "dispatch-extension", factory }],
			},
		});
		const { session } = await createDPiAgentSessionFromServices({
			services,
			sessionManager: createDPiSessionManager("/tmp/d-pi-harness-tools"),
		});

		await session.bindExtensions(makeBindOptions());

		expect(session.getToolDefinitions().map((tool) => tool.name)).toEqual(["dispatch_bash"]);
	});

	it("binds extensions before constructing DPiAgentRuntime with registered tools", async () => {
		const source = await readFile(new URL("../src/worker/agent-worker.ts", import.meta.url), "utf8");
		const bindIndex = source.indexOf("await rebindSession();");
		const runtimeIndex = source.indexOf("agentRuntime = new DPiAgentRuntime");

		expect(bindIndex).toBeGreaterThan(0);
		expect(runtimeIndex).toBeGreaterThan(bindIndex);
		expect(source).toContain("tools: runtime!.session.getToolDefinitions()");
		expect(source).toContain("activeToolNames: config.includeTools");
	});

	it("serves current observable state over IPC instead of a placeholder list", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());
		proxy.setBanner({
			appName: "d-pi",
			version: "test",
			expandedHints: [],
			compactHints: [],
			compactOnboarding: "ready",
			onboarding: "d-pi worker ready for tests",
			loadedResources: [],
			diagnostics: [],
			changelogMarkdown: undefined,
		});
		const harness = createIpcHarness(proxy);
		try {
			const response = await queryIpc(harness, "state-1", "state");

			expect(response.status).toBe(200);
			expect(response.body).toMatchObject({
				agent: expect.objectContaining({
					sessionId: expect.any(String),
				}),
				session: expect.objectContaining({
					id: expect.any(String),
				}),
				banner: expect.objectContaining({ appName: "d-pi", onboarding: "d-pi worker ready for tests" }),
				messages: [],
				streaming: false,
				queued: [],
				tokenUsage: expect.objectContaining({ input: 0, output: 0 }),
				contextUsage: expect.objectContaining({ tokens: 0, percent: 0 }),
				remoteSettings: expect.objectContaining({ autoCompact: true }),
			});
		} finally {
			harness.server.stop();
		}
	});

	it("exposes the default thinking level from settings in interactive state", async () => {
		const services = await createDPiAgentSessionServices({
			cwd: "/tmp/d-pi-thinking-state",
			agentDir: "/tmp/d-pi-thinking-state",
			authStorage: { kind: "d-pi-auth-storage" },
			settingsManager: asWorkerSettingsManager(makeSettingsManager({ defaultThinkingLevel: "high" })),
			modelRegistry: asWorkerModelRegistry(makeModelRegistry({})),
		});
		const { session } = await createDPiAgentSessionFromServices({
			services,
			sessionManager: createDPiSessionManager("/tmp/d-pi-thinking-state"),
		});
		const state = new DPiLocalAgentSessionProxy(createTestRuntime(session)).getState();

		expect(state.thinkingLevel).toBe("high");
		expect(state.remoteSettings.thinkingLevel).toBe("high");
		expect(state.contextUsage.tokens).toBe(0);
		expect(state.contextUsage.percent).toBe(0);
	});

	it("routes extension input handler sendMessage output into proxy state and SSE", async () => {
		const factory = vi.fn((pi: ExtensionAPI) => {
			pi.on("input", (event) => {
				pi.sendMessage(
					{
						role: "custom",
						customType: "extension-input",
						content: [{ type: "text", text: `extension handled: ${event.text}` }],
						display: true,
						details: {
							source: event.source,
							streamingBehavior: event.streamingBehavior,
							marker: "extension-details-visible",
						},
					},
					{ triggerTurn: true, deliverAs: "next" },
				);
				return { action: "handled" };
			});
		});
		const services = await createDPiAgentSessionServices({
			cwd: "/tmp/d-pi-extension-input",
			agentDir: "/tmp/d-pi-extension-input",
			authStorage: { kind: "d-pi-auth-storage" },
			settingsManager: asWorkerSettingsManager(makeSettingsManager()),
			modelRegistry: asWorkerModelRegistry(makeModelRegistry({})),
			resourceLoaderOptions: {
				extensionFactories: [{ name: "input-extension", factory }],
			},
		});
		const { session } = await createDPiAgentSessionFromServices({
			services,
			sessionManager: createDPiSessionManager("/tmp/d-pi-extension-input"),
		});

		await session.bindExtensions(makeBindOptions());

		const harness = createIpcHarness(new DPiLocalAgentSessionProxy(createTestRuntime(session)));
		try {
			harness.transport.emit({ type: "sse_subscribe", subscriberId: "sub-extension" });
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-extension" && event.event === "state"),
			);

			const prompt = await requestIpc(harness, "prompt-extension", "prompt", { text: "ping extension" });
			expect(prompt).toMatchObject({ status: 200, body: { ok: true } });

			await waitFor(() =>
				harness.events.some(
					(event) =>
						event.subscriberId === "sub-extension" &&
						event.event === "message" &&
						isExtensionInputMessage(event.data),
				),
			);

			const state = await queryIpc(harness, "state-extension", "state");
			expect(state.status).toBe(200);
			expect(state.body).toMatchObject({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "user", content: "ping extension" }),
					expect.objectContaining({
						role: "custom",
						customType: "extension-input",
						content: [{ type: "text", text: "extension handled: ping extension" }],
						details: expect.objectContaining({
							source: "programmatic",
							marker: "extension-details-visible",
						}),
					}),
				]),
			});
			expect(harness.events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						subscriberId: "sub-extension",
						event: "state",
						data: expect.objectContaining({
							messages: expect.arrayContaining([
								expect.objectContaining({
									customType: "extension-input",
									details: expect.objectContaining({ marker: "extension-details-visible" }),
								}),
							]),
						}),
					}),
				]),
			);
		} finally {
			harness.server.stop();
		}
	});

	it("handles prompt, steer, and follow-up IPC requests by mutating state and emitting events", async () => {
		const harness = createIpcHarness(new DPiLocalAgentSessionProxy(createTestRuntime()));
		try {
			const prompt = await requestIpc(harness, "prompt-1", "prompt", {
				text: "write a plan",
				options: { images: [{ url: "file:///tmp/prompt.png" }] },
			});
			const steer = await requestIpc(harness, "steer-1", "steer", {
				text: "tighten scope",
				images: [{ url: "file:///tmp/steer.png" }],
			});
			const followUp = await requestIpc(harness, "follow-up-1", "follow-up", {
				text: "continue",
				images: [{ url: "file:///tmp/follow-up.png" }],
			});

			expect(prompt).toMatchObject({ status: 200, body: { ok: true } });
			expect(steer).toMatchObject({ status: 200, body: { ok: true } });
			expect(followUp).toMatchObject({ status: 200, body: { ok: true } });

			const state = await queryIpc(harness, "state-after-actions", "state");
			expect(state.body).toMatchObject({
				streaming: false,
				queued: [
					expect.objectContaining({ kind: "steer", text: "tighten scope" }),
					expect.objectContaining({ kind: "follow-up", text: "continue" }),
				],
				steeringMessages: ["tighten scope"],
				followUpMessages: ["continue"],
				messages: [expect.objectContaining({ role: "user", content: "write a plan" })],
			});
			expect(JSON.stringify(state.body)).not.toContain('"customType":"steer"');
			expect(JSON.stringify(state.body)).not.toContain('"customType":"follow-up"');
			expect(JSON.stringify(state.body)).not.toContain("d-pi local runtime accepted");
		} finally {
			harness.server.stop();
		}
	});

	it("acks long-running prompt actions immediately and leaves progress to SSE", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());
		proxy.prompt = async () => {
			await new Promise(() => {});
		};
		const harness = createIpcHarness(proxy);
		try {
			harness.transport.emit({
				type: "http_request",
				requestId: "prompt-ack",
				action: "prompt",
				data: { text: "slow" },
			});
			await waitFor(() => harness.responses.some((response) => response.requestId === "prompt-ack"));

			expect(harness.responses.find((response) => response.requestId === "prompt-ack")).toMatchObject({
				status: 200,
				body: { ok: true },
			});
		} finally {
			harness.server.stop();
		}
	});

	it("imports assistant messages from runtime events instead of fabricating local acknowledgements", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());
		const harness = createIpcHarness(proxy);
		try {
			harness.transport.emit({ type: "sse_subscribe", subscriberId: "sub-runtime" });
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-runtime" && event.event === "state"),
			);

			proxy.applyRuntimeEvent({
				type: "assistant_stream",
				agentName: "root",
				done: true,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "real runtime response" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4",
					stopReason: "stop",
					usage: {
						input: 10,
						output: 4,
						cacheRead: 3,
						cacheWrite: 1,
						totalTokens: 18,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 3,
				},
			});

			await waitFor(() =>
				harness.events.some(
					(event) =>
						event.subscriberId === "sub-runtime" &&
						event.event === "message" &&
						typeof event.data === "object" &&
						event.data !== null &&
						"role" in event.data &&
						event.data.role === "assistant",
				),
			);
			const state = await queryIpc(harness, "state-runtime", "state");

			expect(JSON.stringify(state.body)).toContain("real runtime response");
			expect(JSON.stringify(state.body)).not.toContain("d-pi local runtime accepted");
		} finally {
			harness.server.stop();
		}
	});

	it("does not record steering inputs as transcript messages while the runtime is streaming", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());

		proxy.applyRuntimeEvent({ type: "agent_start", agentName: "root" });
		await proxy.steer("interrupt one");
		await proxy.steer("interrupt two");

		const state = proxy.getState();
		expect(state.steeringMessages).toEqual(["interrupt one", "interrupt two"]);
		expect(JSON.stringify(state.messages)).not.toContain("interrupt one");
		expect(JSON.stringify(state.messages)).not.toContain("customType");
	});

	it("records queued steering messages as user transcript messages when the runtime consumes them", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());

		proxy.applyRuntimeEvent({ type: "agent_start", agentName: "root" });
		await proxy.steer("interrupt one");
		proxy.applyRuntimeEvent({
			type: "message",
			agentName: "root",
			message: {
				role: "user",
				content: "interrupt one",
				timestamp: 123,
			},
		} as never);
		proxy.applyRuntimeEvent({
			type: "queue_update",
			agentName: "root",
			queues: { prompts: [], tools: [] },
		});

		const state = proxy.getState();
		expect(state.steeringMessages).toEqual([]);
		expect(state.messages).toEqual([expect.objectContaining({ role: "user", content: "interrupt one" })]);
		expect(JSON.stringify(state.messages)).not.toContain('"customType":"steer"');
	});

	it("does not duplicate direct prompt transcript messages when runtime user confirmation arrives later", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());

		await proxy.prompt("direct prompt");
		proxy.applyRuntimeEvent({
			type: "assistant_stream",
			agentName: "root",
			done: true,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ack" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		});
		proxy.applyRuntimeEvent({
			type: "message",
			agentName: "root",
			message: {
				role: "user",
				content: [{ type: "text", text: "direct prompt" }],
				timestamp: 1,
			},
		});

		const state = proxy.getState();
		expect(state.messages.filter((message) => message.role === "user")).toEqual([
			expect.objectContaining({ content: "direct prompt" }),
		]);
		expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	});

	it("keeps repeated direct prompts distinct while deduplicating their runtime confirmations", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());

		await proxy.prompt("same");
		proxy.applyRuntimeEvent({
			type: "message",
			agentName: "root",
			message: { role: "user", content: [{ type: "text", text: "same" }], timestamp: 1 },
		});
		await proxy.prompt("same");
		proxy.applyRuntimeEvent({
			type: "message",
			agentName: "root",
			message: { role: "user", content: [{ type: "text", text: "same" }], timestamp: 2 },
		});

		expect(proxy.getState().messages.filter((message) => message.role === "user")).toHaveLength(2);
	});

	it("projects runtime tool lifecycle into native tool call and result messages", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());
		const harness = createIpcHarness(proxy);
		try {
			harness.transport.emit({ type: "sse_subscribe", subscriberId: "sub-tools" });
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-tools" && event.event === "state"),
			);

			proxy.applyRuntimeEvent({
				type: "tool_start",
				agentName: "root",
				tool: {
					id: "tool-ls",
					name: "dispatch_ls",
					args: { path: "." },
					startedAt: 1,
				},
			});
			await waitFor(() =>
				harness.events.some(
					(event) => event.subscriberId === "sub-tools" && event.event === "tool_execution_start",
				),
			);

			proxy.applyRuntimeEvent({
				type: "tool_end",
				agentName: "root",
				toolCallId: "tool-ls",
				status: "succeeded",
				result: {
					content: [{ type: "text", text: "package.json\nsrc" }],
				},
				endedAt: 2,
			});
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-tools" && event.event === "tool_execution_end"),
			);

			const state = await queryIpc(harness, "state-tools", "state");
			const body = state.body as {
				messages: Array<{ role: string; content: unknown; toolCallId?: string }>;
			};
			expect(body.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						content: [expect.objectContaining({ type: "toolCall", id: "tool-ls", name: "dispatch_ls" })],
					}),
					expect.objectContaining({
						role: "toolResult",
						toolCallId: "tool-ls",
						content: [expect.objectContaining({ type: "text", text: "package.json\nsrc" })],
					}),
				]),
			);
		} finally {
			harness.server.stop();
		}
	});

	it("preserves tool result messages when a runtime session is replaced", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());

		proxy.applyRuntimeEvent({
			type: "session_replaced",
			agentName: "root",
			session: { id: "next-session" },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-ls", name: "dispatch_ls", arguments: { path: "." } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4",
					stopReason: "toolUse",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "tool-ls",
					toolName: "dispatch_ls",
					content: [{ type: "text", text: "package.json\nsrc" }],
					isError: false,
					timestamp: 2,
				},
			],
		});

		expect(proxy.getState().messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "tool-ls",
					content: [expect.objectContaining({ type: "text", text: "package.json\nsrc" })],
				}),
			]),
		);
	});

	it("forwards native agent start and end events so connect mode can show the working loader immediately", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());
		const harness = createIpcHarness(proxy);
		try {
			harness.transport.emit({ type: "sse_subscribe", subscriberId: "sub-runtime" });
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-runtime" && event.event === "state"),
			);

			proxy.applyRuntimeEvent({ type: "agent_start", agentName: "root" });
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-runtime" && event.event === "agent_start"),
			);
			let state = await queryIpc(harness, "state-agent-start", "state");
			expect(state.body).toMatchObject({ streaming: true, agent: { status: "busy" } });

			proxy.applyRuntimeEvent({
				type: "assistant_stream",
				agentName: "root",
				done: true,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "still in turn" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4",
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 1,
				},
			});
			state = await queryIpc(harness, "state-assistant-done", "state");
			expect(state.body).toMatchObject({ streaming: true, agent: { status: "busy" } });

			proxy.applyRuntimeEvent({ type: "agent_end", agentName: "root" });
			await waitFor(() =>
				harness.events.some((event) => event.subscriberId === "sub-runtime" && event.event === "agent_end"),
			);
			state = await queryIpc(harness, "state-agent-end", "state");
			expect(state.body).toMatchObject({ streaming: false, agent: { status: "ready" } });
		} finally {
			harness.server.stop();
		}
	});

	it("keeps the streaming assistant message visible and updates it in place before agent end", async () => {
		const proxy = new DPiLocalAgentSessionProxy(createTestRuntime());
		const harness = createIpcHarness(proxy);
		try {
			proxy.applyRuntimeEvent({ type: "agent_start", agentName: "root" });
			proxy.applyRuntimeEvent({
				type: "assistant_stream",
				agentName: "root",
				done: false,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4",
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 1,
				},
			});
			let state = await queryIpc(harness, "state-streaming-partial", "state");
			expect(JSON.stringify(state.body)).toContain("partial");

			proxy.applyRuntimeEvent({
				type: "assistant_stream",
				agentName: "root",
				done: false,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial updated" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4",
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 2,
				},
			});
			state = await queryIpc(harness, "state-streaming-updated", "state");
			const body = JSON.stringify(state.body);
			expect(body).toContain("partial updated");
			expect(body.match(/"role":"assistant"/g)).toHaveLength(1);
		} finally {
			harness.server.stop();
		}
	});

	it("forwards proxy events to SSE subscribers and stops after unsubscribe", async () => {
		const harness = createIpcHarness(new DPiLocalAgentSessionProxy(createTestRuntime()));
		try {
			harness.transport.emit({ type: "sse_subscribe", subscriberId: "sub-1" });
			await waitFor(() => harness.events.some((event) => event.subscriberId === "sub-1" && event.event === "state"));

			await requestIpc(harness, "prompt-1", "prompt", { text: "hello over sse" });
			await waitFor(() =>
				harness.events.some(
					(event) =>
						event.subscriberId === "sub-1" &&
						event.event === "message" &&
						typeof event.data === "object" &&
						event.data !== null &&
						"content" in event.data &&
						event.data.content === "hello over sse",
				),
			);

			harness.transport.emit({ type: "sse_unsubscribe", subscriberId: "sub-1" });
			const eventCountAfterUnsubscribe = harness.events.length;
			await requestIpc(harness, "prompt-2", "prompt", { text: "after unsubscribe" });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(harness.events).toHaveLength(eventCountAfterUnsubscribe);
		} finally {
			harness.server.stop();
		}
	});

	it("creates distinct session objects and rebind reasons for new, fork, and switch operations", async () => {
		let nextSessionNumber = 0;
		const createdSessions: TestSession[] = [];
		const runtime = await createDPiAgentSessionRuntime(
			async (): Promise<{
				session: DPiWorkerSession;
				diagnostics: unknown[];
				services: DPiAgentSessionServices;
			}> => {
				nextSessionNumber += 1;
				const session = createTestSession(`session-${nextSessionNumber}`);
				createdSessions.push(session);
				return { session, diagnostics: [], services: { diagnostics: [] } };
			},
			{
				cwd: "/tmp/d-pi-runtime",
				agentDir: "/tmp/d-pi-runtime",
				sessionManager: createDPiSessionManager("/tmp/d-pi-runtime", "/tmp/d-pi-runtime/session-initial"),
			},
		);
		const initialSession = runtime.session;
		const invalidations: string[] = [];
		const rebinds: Array<{ session: DPiWorkerSession; reason: "new" | "resume" | "fork" }> = [];
		runtime.setBeforeSessionInvalidate(() => {
			invalidations.push("invalidated");
		});
		runtime.setRebindSession(async (session, reason) => {
			rebinds.push({ session, reason });
		});

		await runtime.newSession({ label: "fresh" });
		await runtime.fork("entry-1", { label: "forked" });
		await runtime.switchSession("/tmp/d-pi-runtime/session-existing", { label: "resumed" });

		expect(invalidations).toHaveLength(3);
		expect(rebinds.map((rebind) => rebind.reason)).toEqual(["new", "fork", "resume"]);
		expect(rebinds.map((rebind) => rebind.session)).not.toContain(initialSession);
		expect(new Set(rebinds.map((rebind) => rebind.session))).toHaveLength(3);
		expect(runtime.session).toBe(rebinds[2].session);
		expect(createdSessions.map((session) => session.testSessionId)).toEqual([
			"session-1",
			"session-2",
			"session-3",
			"session-4",
		]);
	});
});
