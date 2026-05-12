import { describe, expect, it } from "vitest";
import { getPeerCliHelpText, parsePeerCliArgs } from "../../src/peer/cli-args.js";

describe("parsePeerCliArgs", () => {
	it("sets agentId for --agent child-a", () => {
		const { options, help } = parsePeerCliArgs(["--agent", "child-a", "--peer-id", "p"]);
		expect(help).toBe(false);
		expect(options.agentId).toBe("child-a");
	});

	it("parses --disable-executor as an opt-in local safety mode", () => {
		const { options } = parsePeerCliArgs(["--disable-executor"]);
		expect(options.disableExecutor).toBe(true);
	});

	it("parses -p as one-shot message delivery", () => {
		const { options, help } = parsePeerCliArgs(["-p", "hello hub"]);
		expect(help).toBe(false);
		expect(options.message).toBe("hello hub");
		expect(options.noResponse).toBeUndefined();
	});

	it("parses --message with --no-response", () => {
		const { options } = parsePeerCliArgs(["--message", "fire and forget", "--no-response"]);
		expect(options.message).toBe("fire and forget");
		expect(options.noResponse).toBe(true);
	});

	it("treats --help as help without requiring other flags", () => {
		const { help } = parsePeerCliArgs(["--help"]);
		expect(help).toBe(true);
	});

	it("throws for missing value after --agent", () => {
		expect(() => parsePeerCliArgs(["--agent"])).toThrow(/Missing value for --agent/);
	});

	it("rejects the empty string as --agent value", () => {
		expect(() => parsePeerCliArgs(["--agent", ""])).toThrow(/Invalid value for --agent: value cannot be empty/);
	});

	it("throws when value after --agent is another flag", () => {
		expect(() => parsePeerCliArgs(["--agent", "--hub"])).toThrow(
			/Invalid value for --agent: expected an argument, found "--hub"/,
		);
	});

	it("throws for missing value after --hub", () => {
		expect(() => parsePeerCliArgs(["--hub"])).toThrow(/Missing value for --hub/);
	});

	it("throws for missing value after -p", () => {
		expect(() => parsePeerCliArgs(["-p"])).toThrow(/Missing value for -p/);
	});

	it("throws when --no-response is used without a one-shot message", () => {
		expect(() => parsePeerCliArgs(["--no-response"])).toThrow(/--no-response requires -p or --message/);
	});

	it("getPeerCliHelpText documents --agent and default main binding", () => {
		const t = getPeerCliHelpText("d-pi peer");
		expect(t).toContain("--agent");
		expect(t).toMatch(/default.*root|"root"/i);
		expect(t).toContain("Use --agent to choose root/child");
		expect(t).toContain("--peer-id only sets this peer's identity");
		expect(t).toContain("--disable-executor");
		expect(t).toContain("-p, --message");
		expect(t).toContain("--no-response");
	});

	it("getPeerCliHelpText documents source, MCP, and skill configuration examples", () => {
		const t = getPeerCliHelpText("d-pi peer");
		expect(t).toContain("d-pi peer --hub http://127.0.0.1:4317");
		expect(t).toContain("d-pi peer --agent writer");
		expect(t).toContain('d-pi peer --hub http://127.0.0.1:4317 -p "hello"');
		expect(t).toContain(".pi/sources.json");
		expect(t).toContain('"method":"queue/write"');
		expect(t).toContain(".pi/mcp.json");
		expect(t).toContain('"mcpServers"');
		expect(t).toContain(".pi/skills/<skill-name>/SKILL.md");
	});
});
