import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fauxAssistantMessage, registerFauxProvider } from "@sheason/pi-ai";
import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { AuthStorage, createAgentSessionServices, ModelRegistry } from "@sheason/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import type { McpClientHandle } from "../../src/hub/mcp/mcp-client.js";
import { getMcpConfigPath } from "../../src/hub/mcp/mcp-config.js";
import { McpHost, type McpHostOptions } from "../../src/hub/mcp/mcp-host.js";
import type { McpServerConfig, McpToolSummary } from "../../src/hub/mcp/types.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

function createStubClient(partial: Partial<Client> & { callTool: Client["callTool"] }): Client {
	return partial as Client;
}

function makeToolSummary(name: string): McpToolSummary {
	return { name, description: "d", inputSchema: { type: "object", properties: {} } };
}

function buildFakeHandle(transport: McpServerConfig["transport"], tools: McpToolSummary[]): McpClientHandle {
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

describe("HubRuntime MCP startup and wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("awaits mcpHost.start() before HubAgentAdapter.create during initializeAgentAdapter", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-mcp-order-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);

		const order: string[] = [];
		const origMcpStart = McpHost.prototype.start;
		vi.spyOn(McpHost.prototype, "start").mockImplementation(async function mcpStartWrap(this: McpHost) {
			order.push("mcp");
			return (origMcpStart as (this: McpHost) => Promise<void>).call(this);
		});

		const stubAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			order.push("adapter");
			return stubAdapter;
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();

		expect(order).toEqual(["mcp", "adapter"]);
	});

	it("after reload with an updated mcp.json, the shared customTools array includes new MCP-prefixed tools (fake createClient)", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-rt-mcp-reload-"));
		const agentDir = mkdtempSync(join(tmpdir(), "hub-rt-mcp-reload-agent-"));
		tempDirs.push(workspaceDir, agentDir);

		initializeWorkspace(workspaceDir);
		const piDir = join(workspaceDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			getMcpConfigPath(workspaceDir),
			`${JSON.stringify(
				{ servers: [{ resourceId: "alpha-id", name: "alpha", transport: "stdio" as const, command: "x" }] },
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
			cwd: workspaceDir,
			agentDir,
			authStorage,
			modelRegistry,
		});

		const createClient: NonNullable<McpHostOptions["createClient"]> = vi
			.fn()
			.mockImplementation(async (cfg: McpServerConfig) => {
				if (cfg.name === "alpha") {
					return buildFakeHandle(cfg.transport, [makeToolSummary("t1")]);
				}
				return buildFakeHandle(cfg.transport, [makeToolSummary("t2")]);
			});

		const runtime = HubRuntime.open(workspaceDir, { mcp: { createClient } });
		await runtime.initializeAgentAdapter({
			services,
			model: faux.getModel(),
		});

		expect(runtime.tools.some((t) => t.name.startsWith("mcp__alpha-id__"))).toBe(true);

		const secondServerBody = {
			servers: [
				{ resourceId: "alpha-id", name: "alpha", transport: "stdio" as const, command: "x" },
				{ resourceId: "beta-id", name: "beta", transport: "stdio" as const, command: "y" },
			],
		};
		writeFileSync(getMcpConfigPath(workspaceDir), `${JSON.stringify(secondServerBody, null, 2)}\n`, "utf8");
		const adapter = runtime.agentAdapter;
		if (!adapter) {
			throw new Error("expected agent adapter");
		}
		await adapter.reload();

		expect(runtime.tools.some((t) => t.name.startsWith("mcp__beta-id__"))).toBe(true);
	});

	it("stop() invokes mcpHost.stop()", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-mcp-stop-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const stop = vi.spyOn(McpHost.prototype, "stop").mockResolvedValue(undefined);
		const stubAdapter = { subscribeLiveEvents: () => () => {}, dispose: () => {} } as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stubAdapter);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await runtime.stop();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("passes the same tools array reference to McpHost and the agent adapter (via HubAgentAdapter.create tools)", async () => {
		const captured: { toolsAtCreate?: ToolDefinition[] } = {};
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-mcp-refs-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const stubAdapter = { subscribeLiveEvents: () => () => {}, dispose: () => {} } as unknown as HubAgentAdapter;
		const createSpy = vi.spyOn(HubAgentAdapter, "create").mockImplementation(async (opts) => {
			captured.toolsAtCreate = opts.tools;
			return stubAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		runtime.tools.push({
			name: "z_native_probe",
			label: "z",
			description: "p",
			inputSchema: { type: "object", properties: {} },
			execute: async () => ({
				content: [{ type: "text", text: "x" }],
				isError: false,
				details: undefined,
			}),
		} as unknown as ToolDefinition);
		await runtime.initializeAgentAdapter();
		expect(captured.toolsAtCreate).toBeDefined();
		expect(captured.toolsAtCreate).toBe(runtime.tools);
		expect(runtime.mcpHost.getSharedCustomToolsArray()).toBe(runtime.tools);
		expect(captured.toolsAtCreate).toBe(runtime.mcpHost.getSharedCustomToolsArray());
		createSpy.mockRestore();
	});
});
