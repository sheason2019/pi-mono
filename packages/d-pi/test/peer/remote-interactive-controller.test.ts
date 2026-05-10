import { describe, expect, it, vi } from "vitest";
import type { McpRuntimeStatus } from "../../src/hub/index.js";
import type { PeerAppSnapshot } from "../../src/peer/state/peer-app-state.js";
import type { PeerUiSnapshot } from "../../src/peer/state/peer-ui-state.js";
import { createRemoteInteractiveController } from "../../src/peer/tui/interactive/remote-interactive-controller.js";

describe("remote interactive controller", () => {
	it("preserves runtime method binding for queue write actions", async () => {
		const appSnapshot: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const uiSnapshot: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: "Connected",
			draft: "",
		};
		const runtime = {
			hello: { peerId: "peer-a", cwd: "/tmp/workspace" },
			client: {
				queueWrite: vi.fn(async (_text: string) => {}),
			},
			async queueWrite(text: string) {
				await this.client.queueWrite(text);
			},
			async queueFlush() {},
			submitPrompt: vi.fn(async (_text: string) => {}),
			followUp: vi.fn(async (_text: string) => {}),
			steer: vi.fn(async (_text: string) => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async (_modelResourceId: string) => {}),
			setThinkingLevel: vi.fn(async (_level: "high") => {}),
			invokeCommand: vi.fn(async (_commandName: string, _args?: string) => {}),
			getSessionSources: vi.fn(async () => []),
			pauseSource: vi.fn(async (_name: string) => []),
			restartSource: vi.fn(async (_name: string) => []),
			removeSource: vi.fn(async (_name: string) => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			getSkills: vi.fn(async () => ({ ok: true as const, skills: [], diagnostics: [] })),
			pauseMcpServer: vi.fn(async (_name: string) => []),
			restartMcpServer: vi.fn(async (_name: string) => []),
			removeMcpServer: vi.fn(async (_name: string) => []),
			appState: { getSnapshot: () => appSnapshot },
			uiState: { getSnapshot: () => uiSnapshot },
		};

		const controller = createRemoteInteractiveController(runtime);

		await controller.actions.queueWrite?.("hello");

		expect(runtime.client.queueWrite).toHaveBeenCalledWith("hello");
	});

	it("forwards prompt and follow-up actions to peer runtime", async () => {
		const appSnapshot: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const uiSnapshot: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: "Connected",
			draft: "",
		};
		const runtime = {
			hello: {
				peerId: "peer-a",
				cwd: "/tmp/workspace",
			},
			submitPrompt: vi.fn(async (_text: string) => {}),
			followUp: vi.fn(async (_text: string) => {}),
			steer: vi.fn(async (_text: string) => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async (_modelResourceId: string) => {}),
			setThinkingLevel: vi.fn(async (_level: "high") => {}),
			invokeCommand: vi.fn(async (_commandName: string, _args?: string) => {}),
			getSessionSources: vi.fn(async () => []),
			pauseSource: vi.fn(async (_name: string) => []),
			restartSource: vi.fn(async (_name: string) => []),
			removeSource: vi.fn(async (_name: string) => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			getSkills: vi.fn(async () => ({ ok: true as const, skills: [], diagnostics: [] })),
			pauseMcpServer: vi.fn(async (_name: string) => []),
			restartMcpServer: vi.fn(async (_name: string) => []),
			removeMcpServer: vi.fn(async (_name: string) => []),
			appState: { getSnapshot: () => appSnapshot },
			uiState: { getSnapshot: () => uiSnapshot },
		};

		const controller = createRemoteInteractiveController(runtime);
		await controller.actions.submitPrompt("hello");
		await controller.actions.submitFollowUp("later");
		await controller.actions.steer("now");
		await controller.actions.abort();

		expect(runtime.submitPrompt).toHaveBeenCalledWith("hello");
		expect(runtime.followUp).toHaveBeenCalledWith("later");
		expect(runtime.steer).toHaveBeenCalledWith("now");
		expect(runtime.abort).toHaveBeenCalledTimes(1);
		expect(controller.capabilities.supportsCompact).toBe(true);
		expect(controller.capabilities.supportsSessionFork).toBe(false);
	});

	it("forwards MCP server actions to peer runtime", async () => {
		const mcpRow: McpRuntimeStatus = {
			name: "s",
			transport: "stdio",
			status: "running",
			capabilities: { tools: [], resources: [], prompts: [] },
		};
		const appSnapshot: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const uiSnapshot: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: "Connected",
			draft: "",
		};
		const runtime = {
			hello: { peerId: "p", cwd: "/w" },
			submitPrompt: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(async () => {}),
			invokeCommand: vi.fn(async () => {}),
			getSessionSources: vi.fn(async () => []),
			pauseSource: vi.fn(async () => []),
			restartSource: vi.fn(async () => []),
			removeSource: vi.fn(async () => []),
			getMcpServers: vi.fn(async () => ({ servers: [mcpRow] })),
			getSkills: vi.fn(async () => ({ ok: true as const, skills: [], diagnostics: [] })),
			pauseMcpServer: vi.fn(async () => [mcpRow]),
			restartMcpServer: vi.fn(async () => [mcpRow]),
			removeMcpServer: vi.fn(async () => []),
			appState: { getSnapshot: () => appSnapshot },
			uiState: { getSnapshot: () => uiSnapshot },
		};
		const controller = createRemoteInteractiveController(runtime);
		const list = await controller.actions.getMcpServers();
		expect(list).toEqual({ servers: [mcpRow] });
		expect(runtime.getMcpServers).toHaveBeenCalledTimes(1);
		expect(await controller.actions.pauseMcpServer("s")).toEqual([mcpRow]);
		expect(runtime.pauseMcpServer).toHaveBeenCalledWith("s");
		expect(await controller.actions.restartMcpServer("s")).toEqual([mcpRow]);
		expect(runtime.restartMcpServer).toHaveBeenCalledWith("s");
		expect(await controller.actions.removeMcpServer("s")).toEqual([]);
		expect(runtime.removeMcpServer).toHaveBeenCalledWith("s");
	});

	it("forwards skill list requests to peer runtime", async () => {
		const appSnapshot: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const uiSnapshot: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: "Connected",
			draft: "",
		};
		const response = {
			ok: true as const,
			skills: [
				{
					name: "review",
					description: "Review code",
					filePath: "/tmp/skills/review/SKILL.md",
					disableModelInvocation: false,
				},
			],
			diagnostics: [],
		};
		const runtime = {
			hello: { peerId: "p", cwd: "/w" },
			submitPrompt: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(async () => {}),
			invokeCommand: vi.fn(async () => {}),
			getSessionSources: vi.fn(async () => []),
			pauseSource: vi.fn(async () => []),
			restartSource: vi.fn(async () => []),
			removeSource: vi.fn(async () => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			getSkills: vi.fn(async () => response),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
			appState: { getSnapshot: () => appSnapshot },
			uiState: { getSnapshot: () => uiSnapshot },
		};

		const controller = createRemoteInteractiveController(runtime);

		await expect(controller.actions.getSkills?.()).resolves.toBe(response);
		expect(runtime.getSkills).toHaveBeenCalledTimes(1);
	});

	it("builds a fresh view from the current runtime snapshots", () => {
		const runtime = {
			hello: {
				peerId: "peer-a",
				cwd: "/tmp/workspace",
			},
			submitPrompt: vi.fn(),
			followUp: vi.fn(),
			steer: vi.fn(),
			abort: vi.fn(),
			setModel: vi.fn(),
			setThinkingLevel: vi.fn(),
			invokeCommand: vi.fn(),
			getSessionSources: vi.fn(async () => []),
			pauseSource: vi.fn(async () => []),
			restartSource: vi.fn(async () => []),
			removeSource: vi.fn(async () => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			getSkills: vi.fn(async () => ({ ok: true as const, skills: [], diagnostics: [] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
			appState: {
				getSnapshot: (): PeerAppSnapshot => ({
					welcome: undefined,
					selectedAgent: undefined,
					live: { toolExecutions: [] },
					peers: [],
				}),
			},
			uiState: {
				getSnapshot: (): PeerUiSnapshot => ({
					connectionState: "connecting",
					connectionMessage: "Connecting...",
					draft: "hello",
				}),
			},
		};

		const controller = createRemoteInteractiveController(runtime);
		const view = controller.getView();

		expect(view.connection.state).toBe("connecting");
		expect(view.footer.peerId).toBe("peer-a");
		expect(view.commands.map((command) => command.name)).toEqual([
			"model",
			"settings",
			"compact",
			"reload",
			"group",
			"session",
			"source",
			"mcp",
			"skills",
		]);
	});
});
