import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Api, Model } from "@sheason/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@sheason/pi-ai";
import {
	type AgentSession,
	type AgentSessionServices,
	AuthStorage,
	type CompactionResult,
	createAgentSessionServices,
	type LoadExtensionsResult,
	ModelRegistry,
	type ToolDefinition,
} from "@sheason/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import type { McpClientHandle } from "../../src/hub/mcp/mcp-client.js";
import { getMcpConfigPath } from "../../src/hub/mcp/mcp-config.js";
import { McpHost, type McpHostOptions } from "../../src/hub/mcp/mcp-host.js";
import type { McpServerConfig, McpToolSummary } from "../../src/hub/mcp/types.js";
import type { HubResourceLoader } from "../../src/hub/resources/hub-resource-loader.js";
import { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import { cleanWorkspace, initializeWorkspace } from "../../src/hub/workspace.js";

const hubAdapterReloadTestTools: ToolDefinition[] = [
	{
		name: "hub_reload_adapter_stub",
		label: "stub",
		description: "Constructor stub for HubAgentAdapter test harness",
		inputSchema: { type: "object", properties: {} },
		execute: async () => ({ content: [], isError: false, details: undefined }),
	} as unknown as ToolDefinition,
];

const tempDirs: string[] = [];

function makeMinimalAgentSession(): AgentSession {
	return {
		isStreaming: false,
		state: { pendingToolCalls: [] as string[] },
		messages: [],
		thinkingLevel: "off",
		model: null,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getContextUsage: () => undefined,
		subscribe: () => () => {},
		prompt: async () => {},
		steer: async () => {},
		followUp: async () => {},
		abort: async () => {},
		clearQueue: () => ({ steering: [] as string[], followUp: [] as string[] }),
		setModel: async (_model: Model<Api>) => {},
		cycleModel: async () => undefined,
		compact: async (): Promise<CompactionResult> => ({
			tokensBefore: 0,
			summary: "",
			firstKeptEntryId: "",
		}),
		setAllowedToolNames: vi.fn(),
		setActiveToolsByName: vi.fn(),
		reload: async () => {},
		dispose: () => {},
	} as unknown as AgentSession;
}

const minimalExtensions = {
	extensions: [],
	errors: [],
	runtime: {},
} as unknown as LoadExtensionsResult;

const minimalResourceLoader = {} as unknown as HubResourceLoader;

const minimalServices = {
	modelRegistry: { getAvailable: async () => [], refresh: () => {} },
} as unknown as AgentSessionServices;

type HubAgentAdapterNewArgs = {
	sessionService: HubSessionService;
	session: AgentSession;
	services: AgentSessionServices;
	extensionsResult: LoadExtensionsResult;
	resourceLoader: HubResourceLoader;
	diagnostics: readonly { type: string; message: string }[];
	refreshModelsConfig?: () => void;
	refreshSources?: () => Promise<void>;
	refreshMcp?: () => Promise<void>;
	tools: ToolDefinition[];
};

const HubAgentAdapterForTest = HubAgentAdapter as unknown as new (options: HubAgentAdapterNewArgs) => HubAgentAdapter;

function createStubClient(partial: Partial<Client> & { callTool: Client["callTool"] }): Client {
	return partial as Client;
}

function makeToolSummary(name: string): McpToolSummary {
	return { name, description: "d", inputSchema: { type: "object", properties: {} } };
}

function buildFakeClientHandle(transport: McpServerConfig["transport"], tools: McpToolSummary[]): McpClientHandle {
	const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });
	const client = createStubClient({ callTool: callTool as Client["callTool"] });
	const close = vi.fn().mockResolvedValue(undefined);
	return {
		client,
		capabilities: {
			tools,
			resources: [],
			prompts: [],
		},
		supportedCapabilities: { tools: true, resources: false, prompts: false },
		transport,
		close,
	};
}

describe("HubAgentAdapter.reload refreshes MCP", () => {
	let hubCwd: string;
	let service: HubSessionService;

	beforeEach(() => {
		hubCwd = mkdtempSync(join(tmpdir(), "pi-hub-reload-mcp-"));
		tempDirs.push(hubCwd);
		initializeWorkspace(hubCwd);
		service = HubSessionService.createIfMissing(hubCwd);
	});

	afterEach(() => {
		cleanWorkspace(hubCwd);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	it("invokes the injected refreshMcp callback exactly once on reload()", async () => {
		const refreshMcp = vi.fn().mockResolvedValue(undefined);
		const session = makeMinimalAgentSession();
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services: minimalServices,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			refreshMcp,
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();

		expect(refreshMcp).toHaveBeenCalledTimes(1);
	});

	it("does not throw when reload runs without a refreshMcp callback", async () => {
		const session = makeMinimalAgentSession();
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services: minimalServices,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			tools: hubAdapterReloadTestTools,
		});

		await expect(adapter.reload()).resolves.toBeUndefined();
	});

	it("runs refresh steps in order: refreshModelsConfig, refreshSources, refreshMcp, session.reload, modelRegistry.refresh, setActiveToolsByName, refreshSessionOptions", async () => {
		const calls: string[] = [];
		const refreshModelsConfig = vi.fn(() => {
			calls.push("refreshModelsConfig");
		});
		const refresh = vi.fn(() => {
			calls.push("modelRegistry.refresh");
		});
		const refreshSources = vi.fn(async () => {
			calls.push("refreshSources");
		});
		const refreshMcp = vi.fn(async () => {
			calls.push("refreshMcp");
		});
		const sessionReload = vi.fn(async () => {
			calls.push("session.reload");
		});
		const session = {
			...makeMinimalAgentSession(),
			setActiveToolsByName: vi.fn(() => {
				calls.push("setActiveToolsByName");
			}),
			reload: sessionReload,
		} as unknown as AgentSession;
		const services = {
			modelRegistry: {
				getAvailable: async () => [],
				refresh,
			},
		} as unknown as AgentSessionServices;

		const refreshSessionOptionsSpy = vi
			.spyOn(HubAgentAdapter.prototype, "refreshSessionOptions")
			.mockImplementation(function optionsMock(this: HubAgentAdapter) {
				calls.push("refreshSessionOptions");
				return Promise.resolve();
			});

		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			refreshModelsConfig,
			refreshSources,
			refreshMcp,
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();
		refreshSessionOptionsSpy.mockRestore();

		expect(calls).toEqual([
			"refreshModelsConfig",
			"refreshSources",
			"refreshMcp",
			"session.reload",
			"modelRegistry.refresh",
			"setActiveToolsByName",
			"refreshSessionOptions",
		]);
	});

	it("reload exposes new MCP tool on the same cycle in getActiveToolNames (mcp__demo__hello)", async () => {
		const hubCwd = mkdtempSync(join(tmpdir(), "pi-hub-reload-mcp-visible-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-hub-reload-mcp-ag-"));
		tempDirs.push(hubCwd, agentDir);
		initializeWorkspace(hubCwd);
		const piDir = join(hubCwd, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			getMcpConfigPath(hubCwd),
			`${JSON.stringify(
				{ servers: [{ resourceId: "demo", name: "demo", transport: "stdio" as const, command: "noop" }] },
				null,
				2,
			)}\n`,
			"utf8",
		);

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", name: "Faux 1", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		const services = await createAgentSessionServices({
			cwd: hubCwd,
			agentDir,
			authStorage,
			modelRegistry,
		});

		let createCalls = 0;
		const createClient: NonNullable<McpHostOptions["createClient"]> = async (cfg) => {
			createCalls += 1;
			if (createCalls === 1) {
				return buildFakeClientHandle(cfg.transport, []);
			}
			return buildFakeClientHandle(cfg.transport, [makeToolSummary("hello")]);
		};

		const customTools: ToolDefinition[] = [];
		const mcp = new McpHost({ cwd: hubCwd, customTools, createClient });
		await mcp.start();

		const service = HubSessionService.createIfMissing(hubCwd);
		const adapter = await HubAgentAdapter.create({
			cwd: hubCwd,
			sessionService: service,
			services,
			model: faux.getModel(),
			tools: customTools,
			refreshMcp: async () => {
				await mcp.start();
			},
		});

		expect(customTools.some((t) => t.name === "mcp__demo__hello")).toBe(false);
		expect(adapter.session.getActiveToolNames()).not.toContain("mcp__demo__hello");

		await adapter.reload();
		expect(customTools.some((t) => t.name === "mcp__demo__hello")).toBe(true);
		expect(adapter.session.getActiveToolNames()).toContain("mcp__demo__hello");

		adapter.dispose();
	});

	it("if refreshMcp rejects, the rejection propagates and refreshSessionOptions is not run", async () => {
		const err = new Error("mcp failed");
		const refreshMcp = vi.fn().mockRejectedValue(err);
		const session = makeMinimalAgentSession();
		const refreshSessionOptionsSpy = vi.spyOn(HubAgentAdapter.prototype, "refreshSessionOptions");
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services: minimalServices,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			refreshMcp,
			tools: hubAdapterReloadTestTools,
		});

		await expect(adapter.reload()).rejects.toThrow("mcp failed");
		expect(refreshSessionOptionsSpy).not.toHaveBeenCalled();
		refreshSessionOptionsSpy.mockRestore();
	});
});
