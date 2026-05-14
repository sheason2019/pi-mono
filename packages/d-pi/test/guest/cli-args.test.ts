import { describe, expect, it } from "vitest";
import { parseGuestCliArgs } from "../../src/guest/cli-args.js";

describe("d-pi guest CLI args", () => {
	it("parses stdio ACP command after --", () => {
		const parsed = parseGuestCliArgs([
			"acp",
			"--hub",
			"http://hub",
			"--token",
			"dpi_token",
			"--agent",
			"claude-guest",
			"--name",
			"Claude Guest",
			"--",
			"claude",
			"acp",
			"--dangerously-skip-permissions",
		]);

		expect(parsed).toEqual({
			help: false,
			command: "acp",
			options: {
				hubUrl: "http://hub",
				token: "dpi_token",
				agentId: "claude-guest",
				displayName: "Claude Guest",
				acpCommand: "claude",
				acpArgs: ["acp", "--dangerously-skip-permissions"],
			},
		});
	});

	it("requires an existing guest agent id and external command", () => {
		expect(() => parseGuestCliArgs(["acp", "--", "claude", "acp"])).toThrow(/--agent/);
		expect(() => parseGuestCliArgs(["acp", "--agent", "claude-guest"])).toThrow(/--/);
		expect(() => parseGuestCliArgs(["acp", "--agent", "claude-guest", "--"])).toThrow(/ACP command/);
	});
});
