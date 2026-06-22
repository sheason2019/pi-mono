import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createDispatchTools,
	createReloadTool,
	createTeamTool,
	defineAgent,
	defineAnthropicProvider,
	defineContextFile,
	defineContextFiles,
	defineModel,
	defineOpenAIProvider,
	defineProvider,
	defineRole,
	defineRoles,
	defineSkill,
	defineSource,
	defineTool,
	defineTools,
	defineTuiComponent,
	defineWorkspace,
	getAgentBuiltinToolKind,
} from "../src/index.ts";

function testTool(name: string) {
	return defineTool({
		name,
		description: `${name} description`,
		parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: params.value ?? name }], details: {} };
		},
	});
}

describe("agent definition helpers", () => {
	it("defines rich agent-local model resources with built-in provider helpers", () => {
		const openai = defineOpenAIProvider({
			apiKey: "test-key",
			headers: { "x-test": "1" },
		});
		const anthropic = defineAnthropicProvider();
		const custom = defineProvider({
			provider: "custom-openai",
			api: "openai-responses",
			baseUrl: "https://models.example.test/v1",
		});

		const model = defineModel({
			id: "gpt-test",
			name: "GPT Test",
			provider: openai,
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high" },
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			headers: { "x-model": "agent" },
		});

		expect(openai).toMatchObject({
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
			headers: { "x-test": "1" },
		});
		expect(anthropic).toMatchObject({
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
		});
		expect(custom).toEqual({
			provider: "custom-openai",
			api: "openai-responses",
			baseUrl: "https://models.example.test/v1",
		});
		expect(model).toEqual({
			id: "gpt-test",
			name: "GPT Test",
			provider: openai,
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high" },
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			headers: { "x-model": "agent" },
		});
	});

	it("keeps legacy provider/name model references valid", () => {
		expect(defineModel({ provider: "anthropic", name: "claude-sonnet-4" })).toEqual({
			provider: "anthropic",
			name: "claude-sonnet-4",
		});
	});

	it("defines executable tools and rejects name-only refs", () => {
		const tool = testTool("custom_tool");

		expect(tool).toMatchObject({
			name: "custom_tool",
			label: "custom_tool",
			description: "custom_tool description",
			parameters: expect.objectContaining({ type: "object" }),
		});
		expect(tool.execute).toEqual(expect.any(Function));
		expect(() => defineTool({ name: "dispatch_read" } as never)).toThrow(/description/i);
	});

	it("creates executable built-in tool helper definitions with hidden binding metadata", () => {
		const dispatchTools = createDispatchTools();
		const teamTool = createTeamTool();
		const reloadTool = createReloadTool();

		expect(dispatchTools.map((tool) => tool.name)).toEqual([
			"dispatch_bash",
			"dispatch_read",
			"dispatch_ls",
			"dispatch_grep",
			"dispatch_find",
			"dispatch_write",
			"dispatch_edit",
		]);
		expect(dispatchTools[0]).toMatchObject({
			name: "dispatch_bash",
			label: "Dispatch bash",
			description: expect.any(String),
			parameters: expect.objectContaining({ type: "object" }),
			execute: expect.any(Function),
		});
		expect(getAgentBuiltinToolKind(dispatchTools[0])).toBe("dispatch_bash");
		expect(getAgentBuiltinToolKind(teamTool)).toBe("team");
		expect(getAgentBuiltinToolKind(reloadTool)).toBe("reload");
		expect(Object.keys(teamTool)).not.toContain("@sheason/d-pi.agentBuiltinToolKind");

		const agent = defineAgent({
			tools: [teamTool, reloadTool, ...dispatchTools],
		});
		expect(getAgentBuiltinToolKind(agent.tools[0])).toBe("team");
		expect(getAgentBuiltinToolKind(agent.tools[1])).toBe("reload");
		expect(getAgentBuiltinToolKind(agent.tools[2])).toBe("dispatch_bash");
	});

	it("composes associated resource helpers into an agent definition", () => {
		const agent = defineAgent({
			description: "resource-rich",
			roles: defineRoles(defineRole("planner"), defineRole("reviewer")),
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: defineTools(testTool("dispatch_read"), testTool("team")),
			contextFiles: defineContextFiles(
				defineContextFile({ type: "context", path: "./AGENTS.md" }),
				defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),
			),
		});

		expect(agent.roles).toEqual(["planner", "reviewer"]);
		expect(agent.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(agent.tools.map((tool) => tool.name)).toEqual(["dispatch_read", "team"]);
		expect(agent.contextFiles).toEqual([
			{ type: "context", path: "./AGENTS.md" },
			{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
		]);
	});

	it("does not add legacy resource defaults when fields are omitted", () => {
		const agent = defineAgent({
			description: "minimal",
		});

		expect(agent).toEqual({
			description: "minimal",
			tools: [],
			contextFiles: [],
		});
	});

	it("defines workspace-level TUI components without adding them to agent definitions", () => {
		const renderer = () => undefined;
		const component = defineTuiComponent({
			customType: "d-pi-message",
			render: renderer,
		});
		const agent = defineAgent({
			description: "minimal",
		});

		expect(component).toEqual({
			customType: "d-pi-message",
			render: renderer,
		});
		expect("tuiComponents" in agent).toBe(false);
		expect(() => defineTuiComponent({ customType: "", render: renderer })).toThrow(/customType/i);
		expect(() => defineTuiComponent({ customType: "broken", render: undefined as never })).toThrow(/render/i);
	});

	it("defines workspace-level models and executable sources for agent references", () => {
		const model = defineModel({ provider: "anthropic", name: "claude-sonnet-4" });
		const source = defineSource({
			execute(output) {
				output("hello");
			},
		});
		const workspace = defineWorkspace({
			models: { "anthropic/claude-sonnet-4": model },
			sources: { "lark-bot": source },
		});
		const agent = defineAgent({
			model: workspace.models["anthropic/claude-sonnet-4"],
			sources: { "lark-bot": workspace.sources["lark-bot"]! },
		});

		expect(workspace.models["anthropic/claude-sonnet-4"]).toBe(model);
		expect(workspace.sources["lark-bot"]?.execute).toBe(source.execute);
		expect(workspace.sources["lark-bot"]?.name).toBe("lark-bot");
		expect(Object.keys(workspace.sources["lark-bot"] ?? {})).not.toContain("name");
		expect(agent.model).toEqual(model);
		expect(agent.sources).toEqual({ "lark-bot": workspace.sources["lark-bot"] });
		expect(() => defineWorkspace({ models: { invalid: model } })).toThrow(/provider\/model/);
		expect(() => defineWorkspace({ models: [model] as never })).toThrow(/models must be an object/);
		expect(() => defineWorkspace({ sources: [source] as never })).toThrow(/sources must be an object/);
		expect(() => defineSource({ execute: undefined as never })).toThrow(/execute/i);
	});

	it("copies arrays and nested definitions so caller mutation cannot change the definition", () => {
		const roles = ["reviewer"];
		const tools = [testTool("dispatch_read")];
		const contextFiles = [defineContextFile({ type: "context", path: "./AGENTS.md" })];
		const agent = defineAgent({
			roles,
			tools,
			contextFiles,
			skills: defineSkill({ dir: "./skills" }),
		});

		roles.push("mutated");
		tools.push(testTool("dispatch_write"));
		contextFiles[0] = defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" });

		expect(agent.roles).toEqual(["reviewer"]);
		expect(agent.tools.map((tool) => tool.name)).toEqual(["dispatch_read"]);
		expect(agent.contextFiles).toEqual([{ type: "context", path: "./AGENTS.md" }]);
	});

	it("builds a normalized agent definition without a stored name", () => {
		const parent = defineAgent({
			description: "root",
			roles: [],
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: [testTool("team")],
			contextFiles: [],
		});
		const agent = defineAgent({
			parent,
			description: "reviewer",
			roles: ["reviewer"],
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: [testTool("dispatch_read"), testTool("team")],
			contextFiles: [
				defineContextFile({ type: "context", path: "./AGENTS.md" }),
				defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),
			],
		});

		expect(agent.description).toBe("reviewer");
		expect(agent.roles).toEqual(["reviewer"]);
		expect(agent.parent).toBe(parent);
		expect(agent.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(agent.tools.map((tool) => tool.name)).toEqual(["dispatch_read", "team"]);
		expect(agent.skills).toEqual({ dir: "./skills" });
		expect(agent.contextFiles).toEqual([
			{ type: "context", path: "./AGENTS.md" },
			{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
		]);
		expect("name" in agent).toBe(false);
	});
});
