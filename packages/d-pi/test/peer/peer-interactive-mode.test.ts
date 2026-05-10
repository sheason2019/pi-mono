import { describe, expect, it, vi } from "vitest";
import { PeerInteractiveMode } from "../../src/peer/tui/peer-interactive-mode.js";

describe("peer interactive mode", () => {
	it("constructs from a runtime bridge without reading undefined runtime state", () => {
		const runtime = {
			hello: {
				peerId: "peer-a",
				cwd: "/tmp/workspace",
			},
			appState: {
				getSnapshot: () => ({
					peers: [],
					lastSessionEventSeq: 0,
				}),
				subscribe: vi.fn(() => () => {}),
			},
			uiState: {
				getSnapshot: () => ({
					state: "connected",
					draft: "",
				}),
				subscribe: vi.fn(() => () => {}),
				setDraft: vi.fn(),
			},
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			submitPrompt: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			setThinkingLevel: vi.fn(async () => {}),
			invokeCommand: vi.fn(async () => {}),
			pauseSource: vi.fn(async () => []),
			restartSource: vi.fn(async () => []),
			removeSource: vi.fn(async () => []),
			getMcpServers: vi.fn(async () => ({ servers: [] })),
			pauseMcpServer: vi.fn(async () => []),
			restartMcpServer: vi.fn(async () => []),
			removeMcpServer: vi.fn(async () => []),
		};

		expect(() => new PeerInteractiveMode(runtime as never)).not.toThrow();
	});
});
