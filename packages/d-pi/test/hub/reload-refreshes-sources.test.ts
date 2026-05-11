import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionServices,
	CompactionResult,
	LoadExtensionsResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import type { HubResourceLoader } from "../../src/hub/resources/hub-resource-loader.js";
import { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";
import { SourceHost, type SpawnStdioSource } from "../../src/hub/sources/source-host.js";
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

const minimalServices = {
	modelRegistry: { getAvailable: async () => [], refresh: () => {} },
} as unknown as AgentSessionServices;
const minimalResourceLoader = {} as unknown as HubResourceLoader;

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

function writeSourcesFile(cwd: string, body: unknown): void {
	const piDir = join(cwd, ".pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(getSourcesConfigPath(cwd), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function createMockChild(): ChildProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	return Object.assign(new EventEmitter(), {
		pid: 7,
		stdout,
		stderr,
		kill: () => true,
	}) as ChildProcess;
}

describe("HubAgentAdapter.reload refreshes sources", () => {
	let hubCwd: string;
	let service: HubSessionService;

	beforeEach(() => {
		hubCwd = mkdtempSync(join(tmpdir(), "pi-hub-reload-src-"));
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

	it("invokes the injected refreshSources callback exactly once on reload()", async () => {
		const refreshSources = vi.fn().mockResolvedValue(undefined);
		const session = makeMinimalAgentSession();
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services: minimalServices,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			refreshSources,
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();

		expect(refreshSources).toHaveBeenCalledTimes(1);
	});

	it("does not throw when reload runs without a refreshSources callback", async () => {
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

	it("when wired to SourceHost.start(), reload picks up new entries from .pi/sources.json", async () => {
		writeSourcesFile(hubCwd, {
			sources: [{ name: "first", transport: "stdio", command: "noop" }],
		});

		const spawned: string[] = [];
		const spawn: SpawnStdioSource = () => {
			const proc = createMockChild();
			queueMicrotask(() => proc.emit("spawn"));
			return proc;
		};
		const trackingSpawn: SpawnStdioSource = (config) => {
			spawned.push(config.command);
			return spawn(config);
		};

		const host = new SourceHost({ cwd: hubCwd, spawnStdio: trackingSpawn });
		await host.start();
		expect(host.getStatuses().map((s) => s.name)).toEqual(["first"]);

		writeSourcesFile(hubCwd, {
			sources: [
				{ name: "first", transport: "stdio", command: "noop" },
				{ name: "second", transport: "stdio", command: "noop2" },
			],
		});

		const session = makeMinimalAgentSession();
		const adapter = new HubAgentAdapterForTest({
			sessionService: service,
			session,
			services: minimalServices,
			extensionsResult: minimalExtensions,
			resourceLoader: minimalResourceLoader,
			diagnostics: [],
			refreshSources: () => host.start(),
			tools: hubAdapterReloadTestTools,
		});

		await adapter.reload();
		expect(
			host
				.getStatuses()
				.map((s) => s.name)
				.sort(),
		).toEqual(["first", "second"]);
	});
});
