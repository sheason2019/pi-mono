import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@sheason/pi-ai";
import type {
	AgentSession,
	AgentSessionServices,
	CompactionResult,
	LoadExtensionsResult,
	ToolDefinition,
} from "@sheason/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import type { PeerConfigJsonLayers } from "../../src/hub/config-aggregation/types.js";
import type { HubResourceLoader } from "../../src/hub/resources/hub-resource-loader.js";
import { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import { cleanWorkspace, initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

const hubAdapterReloadTestTools: ToolDefinition[] = [
	{
		name: "hub_reload_adapter_stub",
		label: "stub",
		description: "Constructor stub for HubAgentAdapter test harness",
		inputSchema: { type: "object", properties: {} },
		execute: async () => ({ content: [], isError: false, details: undefined }),
	} as unknown as ToolDefinition,
];

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

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function customModelsConfig(modelId: string): unknown {
	return {
		providers: {
			"reload-test": {
				baseUrl: "https://reload.example/v1",
				apiKey: "reload-key",
				api: "openai-responses",
				models: [
					{
						id: modelId,
						name: modelId,
						api: "openai-responses",
						input: ["text"],
					},
				],
			},
		},
	};
}

type HubAgentAdapterNewArgs = {
	sessionService: HubSessionService;
	session: AgentSession;
	services: AgentSessionServices;
	extensionsResult: LoadExtensionsResult;
	resourceLoader: HubResourceLoader;
	diagnostics: readonly { type: string; message: string }[];
	refreshModelsConfig?: () => void;
	refreshSources?: () => Promise<void>;
	tools: ToolDefinition[];
};

const HubAgentAdapterForTest = HubAgentAdapter as unknown as new (options: HubAgentAdapterNewArgs) => HubAgentAdapter;

describe("HubAgentAdapter.reload refreshes models", () => {
	let hubCwd: string;
	let service: HubSessionService;

	beforeEach(() => {
		hubCwd = mkdtempSync(join(tmpdir(), "pi-hub-reload-models-"));
		tempDirs.push(hubCwd);
		initializeWorkspace(hubCwd);
		service = HubSessionService.createIfMissing(hubCwd);
	});

	afterEach(() => {
		cleanWorkspace(hubCwd);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("calls services.modelRegistry.refresh() once during reload()", async () => {
		const refresh = vi.fn();
		const services = {
			modelRegistry: {
				getAvailable: async () => [],
				refresh,
			},
		} as unknown as AgentSessionServices;
		const session = makeMinimalAgentSession();
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("invokes refreshModelsConfig, refreshSources, session.reload, modelRegistry.refresh, setActiveToolsByName in this order", async () => {
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

		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			refreshModelsConfig,
			refreshSources,
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();

		expect(calls).toEqual([
			"refreshModelsConfig",
			"refreshSources",
			"session.reload",
			"modelRegistry.refresh",
			"setActiveToolsByName",
		]);
	});

	it("after reload, getAvailableModels reflects the latest registry state", async () => {
		const newModel = { id: "fresh", provider: "test" } as Model<Api>;
		let availableModels: Model<Api>[] = [];
		const refresh = vi.fn(() => {
			availableModels = [newModel];
		});
		const services = {
			modelRegistry: {
				getAvailable: () => availableModels,
				refresh,
			},
		} as unknown as AgentSessionServices;
		const session = makeMinimalAgentSession();
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			tools: hubAdapterReloadTestTools,
		});

		expect(await adapter.getAvailableModels()).toEqual([]);
		await adapter.reload();
		expect(await adapter.getAvailableModels()).toEqual([newModel]);
	});

	it("after reload, updates the current model from the refreshed registry when the same model changed", async () => {
		const oldModel = { id: "same", provider: "test", baseUrl: "https://old.example" } as Model<Api>;
		const refreshedModel = { id: "same", provider: "test", baseUrl: "https://new.example" } as Model<Api>;
		const setModel = vi.fn(async (_model: Model<Api>) => {});
		const services = {
			modelRegistry: {
				getAvailable: () => [refreshedModel],
				refresh: vi.fn(),
				find: (provider: string, modelId: string) =>
					provider === refreshedModel.provider && modelId === refreshedModel.id ? refreshedModel : undefined,
			},
		} as unknown as AgentSessionServices;
		const session = {
			...makeMinimalAgentSession(),
			model: oldModel,
			setModel,
		} as unknown as AgentSession;
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();

		expect(setModel).toHaveBeenCalledWith(refreshedModel, { persistDefault: false });
	});

	it("sets the active model without updating shared default settings", async () => {
		const selectedModel = { id: "selected", provider: "test" } as Model<Api>;
		const setModel = vi.fn(async (_model: Model<Api>, _options?: unknown) => {});
		const services = {
			modelRegistry: {
				getAvailable: () => [selectedModel],
			},
		} as unknown as AgentSessionServices;
		const session = {
			...makeMinimalAgentSession(),
			setModel,
		} as unknown as AgentSession;
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			tools: hubAdapterReloadTestTools,
		});

		await adapter.setModel(selectedModel);

		expect(setModel).toHaveBeenCalledWith(selectedModel, { persistDefault: false });
	});

	it("reload re-materializes aggregated model layers before refreshing the registry", async () => {
		const modelsPath = join(hubCwd, ".pi", "models.json");
		mkdirSync(join(hubCwd, ".pi"), { recursive: true });
		writeJson(modelsPath, customModelsConfig("before-reload"));
		const readConfigLayers = (): PeerConfigJsonLayers[] => [
			{
				source: { kind: "hub", scope: "workspace" },
				models: JSON.parse(readFileSync(modelsPath, "utf8")) as unknown,
			},
		];
		const adapter = await HubAgentAdapter.create({
			cwd: hubCwd,
			sessionService: service,
			tools: hubAdapterReloadTestTools,
			configLayers: readConfigLayers(),
			getConfigLayers: readConfigLayers,
		});

		expect(
			(await adapter.getAvailableModels()).some(
				(model) => model.provider === "reload-test" && model.id === "before-reload",
			),
		).toBe(true);

		writeJson(modelsPath, customModelsConfig("after-reload"));
		await adapter.reload();

		expect(
			(await adapter.getAvailableModels()).some(
				(model) => model.provider === "reload-test" && model.id === "after-reload",
			),
		).toBe(true);
		expect(
			service
				.getSnapshot()
				.availableModels.some((model) => model.provider === "reload-test" && model.modelId === "after-reload"),
		).toBe(true);
	});
});
