import { describe, expect, it, vi } from "vitest";
import type { DPiInteractiveAgentSessionProxy } from "../src/tui/interactive/agent-session-proxy.ts";
import { DPI_NATIVE_CONNECT_BUILTIN_COMMANDS } from "../src/tui/interactive/native-parity-manifest.ts";
import {
	handleDPiConnectBashInput,
	handleDPiConnectSlashCommand,
} from "../src/tui/interactive/run-connect-interactive-mode.ts";

function createProxy(): DPiInteractiveAgentSessionProxy {
	return {
		prompt: vi.fn(async () => {}),
		compact: vi.fn(async () => {}),
		setModel: vi.fn(),
		newSession: vi.fn(async () => {}),
		renameSession: vi.fn(),
		reload: vi.fn(async () => {}),
		getSnapshot: vi.fn(() => ({
			sessionName: "session",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/workspace",
			model: "anthropic/claude-sonnet-4",
			thinkingLevel: "medium",
			messages: [],
			contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
			banner: { changelogMarkdown: "changes" },
		})),
	} as unknown as DPiInteractiveAgentSessionProxy;
}

describe("native connect command parity", () => {
	it("handles every native connect builtin locally except /trust fallback", async () => {
		const proxy = createProxy();
		const handlers = {
			proxy,
			showStatus: vi.fn(),
			showAgentSelector: vi.fn(async () => {}),
			showSourcesSelector: vi.fn(async () => {}),
			showModelSelector: vi.fn(async () => {}),
			showSettingsSelector: vi.fn(async () => {}),
			showScopedModelsSelector: vi.fn(async () => {}),
			showResumeSelector: vi.fn(async () => {}),
			showPanel: vi.fn(),
			copyLastAssistantMessage: vi.fn(async () => {}),
			refreshAutocomplete: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
		};

		for (const command of DPI_NATIVE_CONNECT_BUILTIN_COMMANDS) {
			const text = command === "name" ? "/name parity" : `/${command}`;
			await expect(handleDPiConnectSlashCommand(text, handlers), command).resolves.toBe(command !== "trust");
		}

		expect(proxy.prompt).not.toHaveBeenCalled();
	});

	it("blocks native bash prefixes in connect mode", () => {
		const showStatus = vi.fn();

		expect(handleDPiConnectBashInput("!", showStatus)).toBe(true);
		expect(handleDPiConnectBashInput("!! echo ok", showStatus)).toBe(true);
		expect(handleDPiConnectBashInput("echo ok", showStatus)).toBe(false);
	});
});
