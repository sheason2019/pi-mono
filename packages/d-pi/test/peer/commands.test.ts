import { describe, expect, it } from "vitest";
import {
	DISABLED_PEER_COMMAND_NAMES,
	getVisiblePeerCommands,
	parsePeerCommand,
} from "../../src/peer/commands/index.js";
import type { RemoteInteractiveCapabilities } from "../../src/peer/tui/interactive/remote-interactive-capabilities.js";

function createCapabilities(overrides: Partial<RemoteInteractiveCapabilities> = {}): RemoteInteractiveCapabilities {
	return {
		supportsCompact: true,
		supportsReload: true,
		supportsModelSelection: true,
		supportsSessionTree: false,
		supportsSessionCreation: false,
		supportsSessionResume: false,
		supportsSessionFork: false,
		supportsSessionClone: false,
		...overrides,
	};
}

describe("peer command parsing", () => {
	it("exposes only supported commands in the visible command list", () => {
		const names = getVisiblePeerCommands(createCapabilities()).map((command) => command.name);

		expect(names).toEqual(["model", "settings", "compact", "reload", "group", "session", "source", "mcp", "skills"]);
		expect(names).not.toContain("fork");
		expect(DISABLED_PEER_COMMAND_NAMES).toEqual(["new", "resume", "tree", "fork", "clone"]);
	});

	it("filters visible commands through remote capabilities", () => {
		const names = getVisiblePeerCommands(
			createCapabilities({
				supportsModelSelection: false,
				supportsCompact: false,
				supportsReload: false,
			}),
		).map((command) => command.name);

		expect(names).toEqual(["settings", "group", "session", "source", "mcp", "skills"]);
	});

	it("parses model switching with explicit provider and model id", () => {
		expect(parsePeerCommand("/model openai/gpt-4.1")).toEqual({
			kind: "set_model",
			provider: "openai",
			modelId: "gpt-4.1",
		});
	});

	it("parses settings thinking updates", () => {
		expect(parsePeerCommand("/settings thinking high")).toEqual({
			kind: "set_thinking_level",
			level: "high",
		});
	});

	it("parses compact with optional custom instructions", () => {
		expect(parsePeerCommand("/compact keep the recent tool results")).toEqual({
			kind: "compact",
			customInstructions: "keep the recent tool results",
		});
	});

	it("rejects disabled single-session commands with a clear reason", () => {
		expect(parsePeerCommand("/fork")).toEqual({
			kind: "disabled",
			commandName: "fork",
			message: 'Session branching is not enabled in D-Pi hub yet. "/fork" is unavailable right now.',
		});
	});

	it("returns null for plain prompts", () => {
		expect(parsePeerCommand("hello")).toBeNull();
	});

	it("parses /source with no arguments", () => {
		expect(parsePeerCommand("/source")).toEqual({ kind: "show_sources" });
	});

	it("parses /group with no arguments", () => {
		expect(parsePeerCommand("/group")).toEqual({ kind: "show_group" });
	});

	it("rejects /group with arguments", () => {
		expect(parsePeerCommand("/group extra")).toEqual({
			kind: "invalid",
			commandName: "group",
			message: '"/group" does not accept arguments.',
		});
	});

	it("rejects /source with arguments", () => {
		expect(parsePeerCommand("/source extra")).toEqual({
			kind: "invalid",
			commandName: "source",
			message: '"/source" does not accept arguments.',
		});
	});

	it("parses /mcp with no arguments", () => {
		expect(parsePeerCommand("/mcp")).toEqual({ kind: "show_mcp_servers" });
	});

	it("rejects /mcp with arguments", () => {
		expect(parsePeerCommand("/mcp extra")).toEqual({
			kind: "invalid",
			commandName: "mcp",
			message: '"/mcp" does not accept arguments.',
		});
	});

	it("parses /skills with no arguments", () => {
		expect(parsePeerCommand("/skills")).toEqual({ kind: "show_skills" });
	});

	it("rejects /skills with arguments", () => {
		expect(parsePeerCommand("/skills extra")).toEqual({
			kind: "invalid",
			commandName: "skills",
			message: '"/skills" does not accept arguments.',
		});
	});

	it("does not intercept skill invocation prompts", () => {
		expect(parsePeerCommand("/skill:review inspect this change")).toBeNull();
	});
});
