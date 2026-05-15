import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@sheason/pi-tui";
import { describe, expect, it } from "vitest";
import { initTheme, KeybindingsManager } from "../../src/peer/tui/components/index.js";
import { ForkedFooterComponent } from "../../src/peer/tui/forked/components/footer.js";
import type { RemoteInteractiveView } from "../../src/peer/tui/interactive/remote-interactive-view.js";

describe("forked footer", () => {
	it("renders coding-agent style top and stats lines from remote view data", () => {
		initTheme();
		const footer = new ForkedFooterComponent();
		const view: RemoteInteractiveView = {
			connection: { state: "connected", message: "Connected to hub." },
			welcome: {
				sessionId: "session-12345678",
				peerId: "peer-a",
				agentId: "root",
				hubVersion: "0.69.0",
				protocolVersion: 4,
				toolNames: ["read"],
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
			},
			session: undefined,
			peers: [],
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 2, steering 1",
				pendingToolCount: 1,
				peerCount: 2,
				isRunning: true,
				peerId: "peer-a",
				boundAgentId: "main",
				sessionId: "session-12345678",
				contextWindow: 128000,
				contextUsage: {
					tokens: 48000,
					contextWindow: 128000,
					percent: 37.5,
				},
			},
			status: {
				diagnostics: ["diag-a"],
				lastError: "tool failed",
			},
			commands: [],
		};

		footer.setView(view);
		const lines = footer.render(120);
		const cleanLines = lines.map((line) => stripVTControlCharacters(line));

		expect(cleanLines[0]).toContain("/tmp/workspace");
		expect(cleanLines[0]).toContain("session-");
		expect(cleanLines[1]).toContain("running");
		expect(cleanLines[1]).toContain("agent main");
		expect(cleanLines[1]).toContain("37.5%/128k (auto)");
		expect(cleanLines[1]).toContain("openai/gpt-4.1");
		expect(cleanLines[1]).not.toContain("follow-up");
		expect(cleanLines[1]).not.toContain("steering");
		expect(cleanLines[2]).not.toContain("Connected to hub.");
		expect(cleanLines[2]).toContain("diag-a");
		expect(cleanLines[2]).toContain("tool failed");
	});

	it("renders agent child-a in the status line when bound to a child", () => {
		initTheme();
		const footer = new ForkedFooterComponent();
		const view: RemoteInteractiveView = {
			connection: { state: "connected" },
			peers: [],
			footer: {
				cwd: "/tmp/ws",
				modelLabel: "x/y",
				queueSummary: "follow-up 0",
				pendingToolCount: 0,
				peerCount: 1,
				isRunning: false,
				peerId: "p1",
				boundAgentId: "child-a",
			},
			status: { diagnostics: [] },
			commands: [],
		};

		footer.setView(view);
		const line = stripVTControlCharacters(footer.render(120)[1]);
		expect(line).toContain("agent child-a");
	});

	it("renders unknown context usage with the context window like coding-agent", () => {
		initTheme();
		const footer = new ForkedFooterComponent();
		const view: RemoteInteractiveView = {
			connection: { state: "connected" },
			peers: [],
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 0, steering 0",
				pendingToolCount: 0,
				peerCount: 1,
				isRunning: false,
				peerId: "peer-a",
				boundAgentId: "main",
				contextWindow: 200000,
				contextUsage: {
					tokens: null,
					contextWindow: 200000,
					percent: null,
				},
			},
			status: { diagnostics: [] },
			commands: [],
		};

		footer.setView(view);
		const lines = footer.render(120).map((line) => stripVTControlCharacters(line));

		expect(lines[1]).toContain("?/200k (auto)");
	});

	it("shows the configured retry shortcut while reconnecting", () => {
		initTheme();
		const keybindings = KeybindingsManager.create();
		keybindings.setUserBindings({ "app.connection.retry": ["ctrl+r"] });
		setKeybindings(keybindings);
		const footer = new ForkedFooterComponent();
		const view: RemoteInteractiveView = {
			connection: { state: "reconnecting" },
			peers: [],
			footer: {
				cwd: "/tmp/workspace",
				modelLabel: "openai/gpt-4.1",
				queueSummary: "follow-up 0",
				pendingToolCount: 0,
				peerCount: 0,
				isRunning: false,
				peerId: "peer-a",
				boundAgentId: "main",
			},
			status: { connectionMessage: "Connection lost. Retrying in 5s.", diagnostics: [] },
			commands: [],
		};

		footer.setView(view);
		const lines = footer.render(120).map((line) => stripVTControlCharacters(line));

		expect(lines[2]).toContain("Connection lost. Retrying in 5s.");
		expect(lines[2]).toContain("ctrl+r to retry now");
	});
});
