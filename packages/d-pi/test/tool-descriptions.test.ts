import { describe, expect, it } from "vitest";
import { createCreateAgentTool } from "../src/extension/create-agent.ts";
import { createDestroyAgentTool } from "../src/extension/destroy-agent.ts";
import { createGroupArchitectureTool } from "../src/extension/group-architecture.ts";
import type { HubChannel } from "../src/extension/hub-channel.ts";
import { createReloadTools } from "../src/extension/reload-tools.ts";
import { createSendMessageTool } from "../src/extension/send-message.ts";
import { createSetSourceTool } from "../src/extension/set-source.ts";

/**
 * Architectural contract: tool-specific constraints and routing semantics
 * live on the tool's `description` and JSON schema field descriptions, NOT
 * duplicated in the system prompt. This file asserts that contract so
 * regressions surface as test failures.
 */

function makeChannel() {
	return {
		agentId: "test",
		// Each test only calls the methods its tool exercises. Cast through
		// unknown to keep this helper compact.
	} as unknown as HubChannel;
}

function toolDescription(name: string): string {
	const channel = makeChannel();
	switch (name) {
		case "create_agent":
			return createCreateAgentTool(channel).description;
		case "send_message":
			return createSendMessageTool(channel).description;
		case "group_architecture":
			return createGroupArchitectureTool(channel).description;
		case "reload":
			return createReloadTools({
				getReloadFn: () => undefined,
				getResourceLoader: () => undefined,
			}).description;
		case "set_source":
			return createSetSourceTool(channel).description;
		case "destroy_agent":
			return createDestroyAgentTool(channel).description;
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

function toolParamDescriptions(name: string, fieldName: string): string[] {
	const channel = makeChannel();
	let tool: { description: string; parameters: unknown };
	switch (name) {
		case "create_agent":
			tool = createCreateAgentTool(channel);
			break;
		case "send_message":
			tool = createSendMessageTool(channel);
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
	it("description mentions agent.json is NOT re-parsed", () => {
		const desc = toolDescription("reload");
		expect(desc).toMatch(/agent\.json/);
		expect(desc).toMatch(/does NOT re-parse|not re-parse/i);
	});

	it("description mentions hub restart is required for agent.json changes", () => {
		const desc = toolDescription("reload");
		expect(desc).toMatch(/hub restart/i);
	});

	it("description mentions role directories are NOT re-read", () => {
		const desc = toolDescription("reload");
		expect(desc).toMatch(/group-architecture.*role|role directories/i);
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

describe("group_architecture tool — uses agent names", () => {
	it("description reminds callers to use names, not IDs", () => {
		const desc = toolDescription("group_architecture");
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
