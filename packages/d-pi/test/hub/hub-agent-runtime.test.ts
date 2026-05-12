import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { HubAgentRuntime } from "../../src/hub/agents/hub-agent-runtime.js";
import { type AgentRecord, MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import { createHubTools } from "../../src/hub/tools/index.js";
import { PeerToolBridge } from "../../src/hub/tools/peer-tool-bridge.js";
import type { LiveRenderEvent } from "../../src/hub/transport/live-events.js";
import { HUB_PROTOCOL_VERSION } from "../../src/hub/transport/protocol.js";
import { createMainOnlySocketHubServer } from "../../src/hub/transport/socket-hub-server.js";
import { getAgentSessionFile, initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

function headerLine(id: string, cwd: string): string {
	return JSON.stringify({
		type: "session" as const,
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	});
}

function createTestRecord(sessionFileRel: string): AgentRecord {
	return {
		id: MAIN_AGENT_ID,
		kind: "root",
		sessionFile: sessionFileRel,
		createdAt: new Date().toISOString(),
		lifecycle: "persistent",
	};
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

describe("HubAgentRuntime", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("overlapping start() calls in the success path coalesce to a single HubAgentAdapter.create", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-coalesce-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-coalesce", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const server = createMainOnlySocketHubServer(
			sessionService,
			new PeerRegistry(),
			() => [],
			() => undefined,
		);
		await server.start({ host: "127.0.0.1", port: 0 });

		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		const createPromise = new Promise<HubAgentAdapter>((resolve) => {
			setImmediate(() => {
				resolve(stub);
			});
		});
		const createSpy = vi.spyOn(HubAgentAdapter, "create").mockReturnValue(createPromise);
		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });

		const a = runtime.start();
		const b = runtime.start();
		await Promise.all([a, b]);

		expect(createSpy).toHaveBeenCalledOnce();
		expect(runtime.agentAdapter).toBe(stub);

		await runtime.stop();
		await server.stop();
	});

	it("start creates HubAgentAdapter with this runtime sessionService and tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-adapter-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-main", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => undefined,
		);
		await server.start({ host: "127.0.0.1", port: 0 });

		const createSpy = vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);

		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		await runtime.start();
		expect(createSpy).toHaveBeenCalledOnce();
		const first = createSpy.mock.calls[0]![0]!;
		expect(first.sessionService).toBe(sessionService);
		expect(first.tools).toBe(runtime.tools);
		expect(first.cwd).toBe(cwd);

		await runtime.stop();
		await server.stop();
	});

	it("does not add one dynamic tool per peer MCP capability", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-peer-mcp-router-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-peer-mcp", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const registry = new PeerRegistry();
		registry.register(
			"socket-a",
			{
				peerId: "peer-a",
				token: "token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
				executorEnabled: true,
			},
			MAIN_AGENT_ID,
		);
		registry.updateConfigBySocketId("socket-a", {
			tools: ["mcp__peer_a__read_file"],
			mcpSnapshot: {
				servers: [
					{
						name: "fs",
						resourceId: "fs-id",
						transport: "stdio",
						status: "running",
						capabilities: {
							tools: [{ name: "read_file", description: "Read a file" }],
							resources: [],
							prompts: [],
						},
					},
				],
			},
		});
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => undefined,
		);
		await server.start({ host: "127.0.0.1", port: 0 });

		const createSpy = vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);

		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({
			cwd,
			record,
			sessionService,
			socketServer: server,
			peerRegistry: registry,
		});
		await runtime.start();
		const toolNames = createSpy.mock.calls[0]![0]!.tools.map((tool) => tool.name);
		expect(toolNames).toContain("peer_mcp");
		expect(toolNames.some((name) => name.startsWith("mcp__peer_a__"))).toBe(false);

		await runtime.stop();
		await server.stop();
	});

	it("exposes reload_config for agents and reloads this runtime adapter", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-reload-tool-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "helper");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-helper", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => undefined,
		);
		await server.start({ host: "127.0.0.1", port: 0 });
		const reload = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
			reload,
		} as unknown as HubAgentAdapter);
		const record: AgentRecord = {
			id: "helper",
			kind: "child",
			parentId: MAIN_AGENT_ID,
			sessionFile: "agents/helper.jsonl",
			createdAt: new Date().toISOString(),
			lifecycle: "persistent",
		};
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		await runtime.start();
		try {
			const tool = runtime.tools.find((candidate) => candidate.name === "reload_config");
			expect(tool).toBeDefined();
			const result = await tool!.execute("reload-1", {}, undefined, undefined, {} as never);

			expect(reload).toHaveBeenCalledOnce();
			expect(result.content).toEqual([{ type: "text", text: "Reloaded configuration for hub agent helper." }]);
		} finally {
			await runtime.stop();
			await server.stop();
		}
	});

	it("exposes resource_status so agents can inspect MCP and skill diagnostics", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-resource-status-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-resource-status", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => undefined,
		);
		await server.start({ host: "127.0.0.1", port: 0 });
		const resourceStatusText = vi.fn(async () =>
			JSON.stringify({
				mcp: {
					configError: "mcp.json parse failed",
					servers: [{ name: "db", status: "error", error: "connection refused" }],
				},
				skills: {
					diagnostics: [{ type: "error", message: "invalid skill frontmatter", path: "/skills/broken/SKILL.md" }],
				},
			}),
		);
		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({
			cwd,
			record,
			sessionService,
			socketServer: server,
			getResourceStatusHost: () => ({ resourceStatusText }),
		});
		await runtime.start();
		try {
			const tool = runtime.tools.find((candidate) => candidate.name === "resource_status");
			expect(tool).toBeDefined();
			const result = await tool!.execute("resource-status-1", {}, undefined, undefined, {} as never);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(resourceStatusText).toHaveBeenCalledWith(MAIN_AGENT_ID);
			expect(text).toContain("mcp.json parse failed");
			expect(text).toContain("invalid skill frontmatter");
		} finally {
			await runtime.stop();
			await server.stop();
		}
	});

	it("aborts the current adapter before replacing it during restart", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-restart-abort-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("sess-restart-abort", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => undefined,
		);
		await server.start({ host: "127.0.0.1", port: 0 });
		const events: string[] = [];
		const firstAdapter = {
			subscribeLiveEvents: () => () => {},
			abort: vi.fn(async () => {
				events.push("abort");
			}),
			dispose: vi.fn(() => {
				events.push("dispose");
			}),
		} as unknown as HubAgentAdapter;
		const secondAdapter = {
			subscribeLiveEvents: () => () => {},
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(secondAdapter);
		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		runtime.agentAdapter = firstAdapter;

		await runtime.restartAdapter();

		expect(events).toEqual(["abort", "dispose"]);
		expect(runtime.agentAdapter).toBe(secondAdapter);

		await runtime.stop();
		await server.stop();
	});

	it("two runtimes on the same socket server have distinct peer registries", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-reg-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("h1", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const reg = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			reg,
			() => [],
			() => undefined,
		);
		const record = createTestRecord("agents/main.jsonl");
		const a = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		const b = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		expect(a.peerRegistry).not.toBe(b.peerRegistry);
	});
});

describe("createHubTools", () => {
	it("includes peer tool names and optional agent tools without legacy list_peers", () => {
		const peerRegistry = new PeerRegistry();
		const socketServer = createMainOnlySocketHubServer(
			{ subscribe: () => () => {} } as unknown as HubSessionService,
			peerRegistry,
			() => [],
			() => undefined,
		);
		const bridge = new PeerToolBridge(MAIN_AGENT_ID, peerRegistry, socketServer);
		const base = createHubTools({
			cwd: "/tmp",
			agentId: "main",
			peerRegistry,
			peerToolBridge: bridge,
		});
		const names = new Set(base.map((t) => t.name));
		expect(names.has("list_peers")).toBe(false);
		expect(names.has("peer_mcp")).toBe(true);
		expect(names.size).toBeGreaterThan(0);
		const extra = defineTool({
			name: "agent_only_tool",
			label: "agent_only_tool",
			description: "x",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		});
		const merged = createHubTools({
			cwd: "/tmp",
			agentId: "main",
			peerRegistry,
			peerToolBridge: bridge,
			agentTools: [extra],
		});
		expect(merged.map((t) => t.name)).toContain("agent_only_tool");
		bridge.dispose();
	});

	it("includes sharedTools and agentTools in the merged list", () => {
		const peerRegistry = new PeerRegistry();
		const socketServer = createMainOnlySocketHubServer(
			{ subscribe: () => () => {} } as unknown as HubSessionService,
			peerRegistry,
			() => [],
			() => undefined,
		);
		const bridge = new PeerToolBridge(MAIN_AGENT_ID, peerRegistry, socketServer);
		const shared = defineTool({
			name: "shared_mcp_style_tool",
			label: "shared_mcp_style_tool",
			description: "shared",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "s" }], details: {} };
			},
		});
		const agent = defineTool({
			name: "per_agent_tool",
			label: "per_agent_tool",
			description: "agent",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "a" }], details: {} };
			},
		});
		const merged = createHubTools({
			cwd: "/tmp",
			agentId: "main",
			peerRegistry,
			peerToolBridge: bridge,
			sharedTools: [shared],
			agentTools: [agent],
		});
		const names = merged.map((t) => t.name);
		expect(names).toContain("shared_mcp_style_tool");
		expect(names).toContain("per_agent_tool");
		bridge.dispose();
	});
});

describe("HubAgentRuntime live events and stop", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards live events to subscribeLiveEvents listeners", async () => {
		const received: LiveRenderEvent[] = [];
		let liveCb: ((event: LiveRenderEvent) => void) | undefined;
		const stubAdapter = {
			subscribeLiveEvents: (cb: (event: LiveRenderEvent) => void) => {
				liveCb = cb;
				return () => {
					liveCb = undefined;
				};
			},
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stubAdapter);

		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-live-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("hl", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const reg = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			reg,
			() => [],
			() => undefined,
		);
		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		const off = runtime.subscribeLiveEvents((e) => {
			received.push(e);
		});
		await runtime.start();
		liveCb?.({ type: "status", message: "test" });
		expect(received).toEqual([{ type: "status", message: "test" }]);
		off();
		await runtime.stop();
		expect(stubAdapter.dispose).toHaveBeenCalled();
		await server.stop();
	});

	it("stop disposes peer bridge and adapter; repeated stop is safe", async () => {
		const stubAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stubAdapter);
		const bridgeDispose = vi.spyOn(PeerToolBridge.prototype, "dispose");

		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-stop-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("hs", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const reg = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			reg,
			() => [],
			() => undefined,
		);
		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });
		await runtime.start();
		expect(runtime.agentAdapter).toBe(stubAdapter);
		await runtime.stop();
		expect(stubAdapter.dispose).toHaveBeenCalledOnce();
		expect(bridgeDispose).toHaveBeenCalledOnce();
		expect(runtime.agentAdapter).toBeUndefined();
		await runtime.stop();
		expect(stubAdapter.dispose).toHaveBeenCalledOnce();
		expect(bridgeDispose).toHaveBeenCalledOnce();
		await server.stop();
	});

	it("stop() while start() is in flight cancels start, disposes adapter if create resolves after stop, and leaves no attached adapter with bridge torn down", async () => {
		let resolveCreate: (adapter: HubAgentAdapter) => void;
		const createPromise = new Promise<HubAgentAdapter>((resolve) => {
			resolveCreate = resolve;
		});
		const createImpl = vi.fn(() => createPromise);
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(createImpl as (typeof HubAgentAdapter)["create"]);
		const bridgeDispose = vi.spyOn(PeerToolBridge.prototype, "dispose");

		const cwd = mkdtempSync(join(tmpdir(), "hub-agent-rt-race-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const agentPath = getAgentSessionFile(cwd, "main");
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		writeFileSync(agentPath, `${headerLine("hr", cwd)}\n`, "utf8");
		const sessionService = HubSessionService.openAgent(cwd, agentPath);
		const reg = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			reg,
			() => [],
			() => undefined,
		);
		const record = createTestRecord("agents/main.jsonl");
		const runtime = new HubAgentRuntime({ cwd, record, sessionService, socketServer: server });

		const startPromise = runtime.start();
		await Promise.resolve();
		expect(createImpl).toHaveBeenCalled();

		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		// Unblock a slow `create` after `stop()` is waiting on `startInFlight` (same tick ordering would deadlock)
		setImmediate(() => {
			resolveCreate!(stub);
		});
		await runtime.stop();

		await expect(startPromise).rejects.toThrow("HubAgentRuntime: start() aborted by stop()");
		expect(runtime.agentAdapter).toBeUndefined();
		expect(stub.dispose).toHaveBeenCalledOnce();
		expect(bridgeDispose).toHaveBeenCalledOnce();
		await server.stop();
	});
});
