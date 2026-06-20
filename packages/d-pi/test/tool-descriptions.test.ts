import { describe, expect, it } from "vitest";
import {
	createCreateAgentTool,
	createDestroyAgentTool,
	createReloadTool,
	createSendMessageTool,
	createSetSourceTool,
	createTeamTool,
} from "../src/index.ts";

/**
 * Architectural contract: tool-specific constraints and routing semantics
 * live on the tool's `description` and JSON schema field descriptions, NOT
 * duplicated in the system prompt. This file asserts that contract so
 * regressions surface as test failures.
 */

function toolDescription(name: string): string {
	switch (name) {
		case "create_agent":
			return createCreateAgentTool().description;
		case "send_message":
			return createSendMessageTool().description;
		case "team":
			return createTeamTool().description;
		case "reload":
			return createReloadTool().description;
		case "set_source":
			return createSetSourceTool().description;
		case "destroy_agent":
			return createDestroyAgentTool().description;
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

function toolParamDescriptions(name: string, fieldName: string): string[] {
	let tool: { description: string; parameters: unknown };
	switch (name) {
		case "create_agent":
			tool = createCreateAgentTool();
			break;
		case "send_message":
			tool = createSendMessageTool();
			break;
		default:
			throw new Error(`no param field check for tool: ${name}`);
	}
	// TypeBox stores parameter metadata at runtime in `parameters.anyOf` /
	// `parameters.properties`. We just stringify the relevant property to
	// pull out its `description` for assertion.
	const params = tool.parameters as {
		properties?: Record<string, { description?: string }>;
	};
	const prop = params.properties?.[fieldName];
	if (!prop || typeof prop.description !== "string") {
		throw new Error(`tool ${name} param ${fieldName} has no string description`);
	}
	return [prop.description];
}

describe("create_agent tool — includeTools/excludeTools mutex", () => {
	it("includeTools description mentions mutual exclusion with excludeTools", () => {
		const [desc] = toolParamDescriptions("create_agent", "includeTools");
		expect(desc).toMatch(/mutually exclusive/i);
		expect(desc).toContain("excludeTools");
	});

	it("excludeTools description mentions mutual exclusion with includeTools", () => {
		const [desc] = toolParamDescriptions("create_agent", "excludeTools");
		expect(desc).toMatch(/mutually exclusive/i);
		expect(desc).toContain("includeTools");
	});

	it("excludeTools description mentions the inherit-all default behavior", () => {
		const [desc] = toolParamDescriptions("create_agent", "excludeTools");
		// LLM must know that omitting both fields gives all tools.
		expect(desc).toMatch(/both.*omitted|inherit/i);
	});
});

describe("send_message tool — mode semantics", () => {
	it("top-level description explains next/steer mode meaning", () => {
		const desc = toolDescription("send_message");
		expect(desc).toContain("steer");
		expect(desc).toContain("next");
		// Should mention what each mode does at a level that helps the LLM pick.
		expect(desc).toMatch(/interrupt/i);
	});

	it("mode parameter description maps modes to TUI Enter / Ctrl+Enter", () => {
		const [desc] = toolParamDescriptions("send_message", "mode");
		expect(desc).toContain("next");
		expect(desc).toContain("steer");
		expect(desc).toMatch(/Enter/);
		expect(desc).toMatch(/Ctrl\+Enter/);
	});
});

describe("reload tool — limitations", () => {
	it("description mentions agent.ts is NOT re-parsed for hub wiring changes", () => {
		const desc = toolDescription("reload");
		expect(desc).toMatch(/agent\.ts/);
		expect(desc).toMatch(/does NOT re-parse|not re-parse/i);
	});

	it("description mentions hub restart is required for agent.ts wiring changes", () => {
		const desc = toolDescription("reload");
		expect(desc).toMatch(/hub restart/i);
	});

	it("description mentions role directories are NOT re-read", () => {
		const desc = toolDescription("reload");
		expect(desc).toMatch(/team-template.*role|role directories/i);
		expect(desc).toMatch(/not.*re-read|does NOT re-read/i);
	});
});

describe("set_source tool — long-running supervision", () => {
	it("description warns that one-shot commands are not suitable", () => {
		const desc = toolDescription("set_source");
		expect(desc).toMatch(/long-running|long running/i);
		expect(desc).toMatch(/one-shot|persistent/i);
	});

	it("description states source name is the stable ID", () => {
		const desc = toolDescription("set_source");
		expect(desc).toMatch(/name/i);
		expect(desc).toMatch(/stable ID/i);
	});
});

describe("team tool — uses agent names", () => {
	it("description reminds callers to use names, not IDs", () => {
		const desc = toolDescription("team");
		expect(desc).toMatch(/names/i);
		expect(desc).toMatch(/IDs?/);
	});
});

describe("destroy_agent tool — preconditions", () => {
	it("description states the no-children precondition", () => {
		const desc = toolDescription("destroy_agent");
		expect(desc).toMatch(/no children|must have no children/i);
	});
});
