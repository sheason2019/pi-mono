import { describe, expect, it } from "vitest";
import type { HubAgentViewModel, HubWelcomePayload, RegisteredPeer } from "../../src/hub/index.js";
import type { PeerAppSnapshot } from "../../src/peer/state/peer-app-state.js";
import type { PeerUiSnapshot } from "../../src/peer/state/peer-ui-state.js";
import { createRemoteInteractiveView } from "../../src/peer/tui/interactive/remote-interactive-state.js";

describe("remote interactive state", () => {
	it("maps CRDT agent view into interactive footer and status fields", () => {
		const welcome: HubWelcomePayload = {
			sessionId: "session-12345678",
			peerId: "peer-a",
			agentId: "root",
			hubVersion: "0.69.0",
			protocolVersion: 4,
			toolNames: ["group", "read"],
			identity: {
				id: "root",
				name: "root",
				description: "root",
				user: "test-user",
				purpose: "test access",
				scopeRootAgentId: "root",
				createdByAgentId: "root",
				root: true,
			},
			scopeRootAgentId: "root",
		};
		const peers: RegisteredPeer[] = [
			{
				agentId: "root",
				peerId: "peer-a",
				socketId: "socket-1",
				protocolVersion: 1,
				displayName: "MacBook Pro",
				version: "0.69.0",
				platform: "darwin",
				hostname: "macbook-pro",
				cwd: "/tmp/workspace",
				executorEnabled: true,
				tools: ["read", "write"],
				connectedAt: "2026-04-24T00:00:00.000Z",
				transport: "socket.io",
			},
		];
		const selectedAgent: HubAgentViewModel = {
			agentId: "main",
			sessionId: "session-12345678",
			cwd: "/tmp/workspace",
			protocolVersion: 1,
			sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
			status: {
				isRunning: true,
				runStartedAt: "2026-04-24T00:00:30.000Z",
				lastRunStartedAt: "2026-04-24T00:00:30.000Z",
				lastRunEndedAt: "2026-04-24T00:02:12.000Z",
				lastRunDurationMs: 102_000,
				lastRunEndReason: "completed",
			},
			queue: {
				messages: [],
				size: 1,
			},
			context: {
				thinkingLevel: "high",
				model: {
					provider: "openai",
					modelId: "gpt-4.1",
				},
				pendingToolCallIds: ["tool-1"],
				contextUsage: {
					tokens: 48000,
					contextWindow: 128000,
					percent: 37.5,
				},
			},
			items: [],
			live: { itemIndicesById: {}, toolOrder: [], toolsById: {} },
			lastError: "last tool failed",
			diagnostics: ["diagnostic-a"],
			availableModels: [
				{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true, contextWindow: 128000 },
				{
					provider: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					label: "Claude Sonnet 4",
					reasoning: true,
					contextWindow: 200000,
				},
			],
			availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		};
		const app: PeerAppSnapshot = {
			welcome,
			selectedAgent,
			live: { toolExecutions: [] },
			peers,
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: "Connected to hub.",
			draft: "hello",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			visibleCommands: [{ name: "model", description: "Inspect or switch the active model" }],
		});

		expect(view.footer.modelLabel).toBe("openai/gpt-4.1");
		expect(view.footer.boundAgentId).toBe("root");
		expect(view.footer.queueSummary).toBe("queued 0");
		expect(view.footer.pendingToolCount).toBe(1);
		expect(view.footer.peerCount).toBe(1);
		expect(view.footer.contextWindow).toBe(128000);
		expect(view.footer.contextUsage).toEqual({
			tokens: 48000,
			contextWindow: 128000,
			percent: 37.5,
		});
		expect(view.status.connectionMessage).toBeUndefined();
		expect(view.status.diagnostics).toEqual(["diagnostic-a"]);
		expect(view.status.lastError).toBe("last tool failed");
		expect(view.session?.runStartedAt).toBe("2026-04-24T00:00:30.000Z");
		expect(view.session?.lastRunDurationMs).toBe(102_000);
		expect(view.session?.lastRunEndReason).toBe("completed");
		expect(
			view.session?.availableModels.map(
				(model: { provider: string; modelId: string }) => `${model.provider}/${model.modelId}`,
			),
		).toEqual(["openai/gpt-4.1", "anthropic/claude-sonnet-4-20250514"]);
		expect(view.session?.availableThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(view.commands).toEqual([{ name: "model", description: "Inspect or switch the active model" }]);
	});

	it("shows local cancelling status while an abort request is pending", () => {
		const app: PeerAppSnapshot = {
			selectedAgent: {
				agentId: "main",
				sessionId: "session-cancel",
				cwd: "/tmp/workspace",
				protocolVersion: 1,
				sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
				status: { isRunning: true },
				queue: {
					messages: [],
					size: 0,
				},
				context: { thinkingLevel: "off", model: null, pendingToolCallIds: [] },
				items: [],
				live: { itemIndicesById: {}, toolOrder: [], toolsById: {} },
				availableModels: [],
				availableThinkingLevels: [],
				diagnostics: [],
			},
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui = {
			connectionState: "connected",
			connectionMessage: undefined,
			draft: "",
			isCancelling: true,
		} as PeerUiSnapshot & { isCancelling: boolean };

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			visibleCommands: [],
		});

		expect(view.status.liveStatusMessage).toBe("Cancelling...");
	});

	it("tolerates a partially initialized CRDT group view without agentOrder", () => {
		const app: PeerAppSnapshot = {
			view: { agentsById: {} } as PeerAppSnapshot["view"],
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: undefined,
			draft: "",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			visibleCommands: [],
		});

		expect(view.agents).toEqual([]);
	});

	it("maps CRDT group agent models into the agent selector view", () => {
		const rootAgent = createHubAgentView("root", "openai", "gpt-4.1");
		const childAgent = createHubAgentView("child-a", "anthropic", "claude-sonnet-4", {
			parentId: "root",
			name: "Child A",
			isRunning: true,
		});
		const app: PeerAppSnapshot = {
			view: {
				version: 1,
				agentOrder: ["root", "child-a"],
				agentsById: {
					root: rootAgent,
					"child-a": childAgent,
				},
				peers: [],
			},
			selectedAgent: rootAgent,
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: undefined,
			draft: "",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			visibleCommands: [],
		});

		expect(view.agents).toEqual([
			expect.objectContaining({ id: "root", model: { provider: "openai", modelId: "gpt-4.1" } }),
			expect.objectContaining({ id: "child-a", model: { provider: "anthropic", modelId: "claude-sonnet-4" } }),
		]);
	});

	it("uses unprefixed provider names for footer model labels", () => {
		const selectedAgent = {
			agentId: "main",
			sessionId: "session-model-display",
			cwd: "/tmp/workspace",
			protocolVersion: 1,
			status: { isRunning: false },
			queue: { messages: [], size: 0 },
			context: {
				thinkingLevel: "off",
				model: {
					provider: "ark-openai-compatible",
					modelId: "glm-5.1",
				},
				pendingToolCallIds: [],
			},
			items: [],
			live: { itemIndicesById: {}, toolOrder: [], toolsById: {} },
			diagnostics: [],
			availableModels: [
				{
					provider: "ark-openai-compatible",
					modelId: "glm-5.1",
					label: "GLM-5.1",
					reasoning: true,
				},
			],
			availableThinkingLevels: ["off"],
		} satisfies HubAgentViewModel;
		const view = createRemoteInteractiveView(
			{ selectedAgent, live: { toolExecutions: [] }, peers: [] },
			{ connectionState: "connected", draft: "" },
			{
				peerId: "peer-a",
				cwd: "/tmp/workspace",
				visibleCommands: [],
			},
		);

		expect(view.footer.modelLabel).toBe("ark-openai-compatible/glm-5.1");
		expect(view.session?.model?.provider).toBe("ark-openai-compatible");
	});

	it("uses hub welcome agentId for footer when set to a child", () => {
		const welcome: HubWelcomePayload = {
			sessionId: "session-child",
			peerId: "peer-child",
			agentId: "child-a",
			hubVersion: "0.69.0",
			protocolVersion: 4,
			toolNames: ["read"],
			identity: {
				id: "child-token",
				name: "child",
				description: "child scope",
				user: "test-user",
				purpose: "test access",
				scopeRootAgentId: "child-a",
				createdByAgentId: "child-a",
				root: false,
			},
			scopeRootAgentId: "child-a",
		};
		const app: PeerAppSnapshot = {
			welcome,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: undefined,
			draft: "",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-child",
			cwd: "/tmp",
			visibleCommands: [],
			helloAgentId: "other-should-lose",
		});

		expect(view.footer.boundAgentId).toBe("child-a");
	});

	it("uses helloAgentId for footer when hub welcome is not yet applied", () => {
		const app: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connecting",
			connectionMessage: "Connecting...",
			draft: "",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "p",
			cwd: "/tmp",
			visibleCommands: [],
			helloAgentId: "child-a",
		});

		expect(view.footer.boundAgentId).toBe("child-a");
	});

	it("falls back gracefully when the session snapshot is not ready", () => {
		const app: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent: undefined,
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connecting",
			connectionMessage: "Connecting...",
			draft: "",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			visibleCommands: [],
		});

		expect(view.session).toBeUndefined();
		expect(view.footer.modelLabel).toBe("no-model");
		expect(view.footer.queueSummary).toBe("queued 0");
		expect(view.footer.contextWindow).toBeUndefined();
		expect(view.status.connectionMessage).toBe("Connecting...");
		expect(view.footer.boundAgentId).toBe("root");
	});

	it("shows the CRDT queue length in the footer summary", () => {
		const selectedAgent: HubAgentViewModel = {
			agentId: "main",
			sessionId: "session-12345678",
			cwd: "/tmp/workspace",
			protocolVersion: 1,
			sessionFile: "/tmp/workspace/.pi-hub/session.jsonl",
			status: { isRunning: false },
			queue: {
				messages: [
					{ text: "补一句", messageSource: { kind: "peer", name: "peer-a" } },
					{ text: "再补一句", messageSource: { kind: "peer", name: "peer-a" } },
				],
				size: 2,
			},
			context: {
				thinkingLevel: "high",
				model: {
					provider: "openai",
					modelId: "gpt-4.1",
				},
				pendingToolCallIds: [],
			},
			items: [],
			live: { itemIndicesById: {}, toolOrder: [], toolsById: {} },
			diagnostics: [],
			availableModels: [{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true }],
			availableThinkingLevels: ["off", "high"],
		};
		const app: PeerAppSnapshot = {
			welcome: undefined,
			selectedAgent,
			live: { toolExecutions: [] },
			peers: [],
		};
		const ui: PeerUiSnapshot = {
			connectionState: "connected",
			connectionMessage: undefined,
			draft: "",
		};

		const view = createRemoteInteractiveView(app, ui, {
			peerId: "peer-a",
			cwd: "/tmp/workspace",
			visibleCommands: [],
		});

		expect(view.footer.queueSummary).toBe("queued 2");
	});
});

function createHubAgentView(
	agentId: string,
	provider: string,
	modelId: string,
	options: { parentId?: string; name?: string; isRunning?: boolean } = {},
): HubAgentViewModel {
	return {
		agentId,
		...(options.parentId === undefined ? {} : { parentId: options.parentId }),
		...(options.name === undefined ? {} : { name: options.name }),
		status: { isRunning: options.isRunning ?? false },
		queue: { messages: [], size: 0 },
		context: {
			thinkingLevel: "off",
			model: { provider, modelId },
			pendingToolCallIds: [],
		},
		items: [],
		live: { itemIndicesById: {}, toolOrder: [], toolsById: {} },
		availableModels: [{ provider, modelId, label: modelId, reasoning: true }],
		availableThinkingLevels: ["off"],
		diagnostics: [],
	};
}
