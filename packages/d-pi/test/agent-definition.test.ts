import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createDispatchBashTool,
	createDispatchReadTool,
	createReloadTool,
	createSendMessageTool,
	createSyncAgentsTool,
	createTeamTool,
	defineAgent,
	defineAnthropicProvider,
	defineModel,
	defineOpenAIProvider,
	defineProvider,
	defineSkill,
	defineTool,
	defineTools,
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
			description: "Strong local model for complex coding tasks",
			provider: openai,
			reasoning: true,
			thinkingLevel: "high",
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
			description: "Strong local model for complex coding tasks",
			provider: openai,
			reasoning: true,
			thinkingLevel: "high",
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			headers: { "x-model": "agent" },
		});
	});

	it("keeps legacy provider/name model references valid", () => {
		expect(
			defineModel({
				provider: "anthropic",
				name: "claude-sonnet-4",
				description: "Strong hosted model",
			}),
		).toEqual({
			provider: "anthropic",
			name: "claude-sonnet-4",
			description: "Strong hosted model",
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

	it("creates built-in tool definitions directly without stub replacement", () => {
		const allBuiltinTools = [
			createSendMessageTool(),
			createSyncAgentsTool(),
			createTeamTool(),
			createDispatchBashTool(),
			createDispatchReadTool(),
			createReloadTool(),
		];
		const expectedNames = ["send_message", "sync_agents", "team", "dispatch_bash", "dispatch_read", "reload"];
		expect(allBuiltinTools.map((t) => t.name)).toEqual(expectedNames);
		for (const tool of allBuiltinTools) {
			expect(tool.label).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.parameters).toBeTruthy();
			expect(tool.execute).toBeInstanceOf(Function);
		}

		const agent = defineAgent({
			tools: allBuiltinTools,
		});
		expect(agent.tools.map((t) => t.name)).toEqual(expectedNames);
	});

	it("composes associated resource helpers into an agent definition", () => {
		const agent = defineAgent({
			description: "resource-rich",
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: defineTools(testTool("dispatch_read"), testTool("team")),
		});

		expect(agent.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(agent.tools.map((tool) => tool.name)).toEqual(["dispatch_read", "team"]);
		expect(agent.skills).toEqual({ dir: "./skills" });
	});

	it("does not add legacy resource defaults when fields are omitted", () => {
		const agent = defineAgent({
			description: "minimal",
		});

		expect(agent).toEqual({
			description: "minimal",
			tools: [],
			commands: [],
			middlewares: [],
			sources: [],
			autoCompact: true,
			disableDefaultTools: false,
		});
	});

	it("copies arrays and nested definitions so caller mutation cannot change the definition", () => {
		const tools = [testTool("dispatch_read")];
		const agent = defineAgent({
			tools,
			skills: defineSkill({ dir: "./skills" }),
		});

		tools.push(testTool("dispatch_write"));

		expect(agent.tools.map((tool) => tool.name)).toEqual(["dispatch_read"]);
	});

	it("builds a normalized agent definition without a stored name", () => {
		const parent = defineAgent({
			description: "root",
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: [testTool("team")],
		});
		const agent = defineAgent({
			parent,
			description: "reviewer",
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: [testTool("dispatch_read"), testTool("team")],
		});

		expect(agent.description).toBe("reviewer");
		expect(agent.parent).toBe(parent);
		expect(agent.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(agent.tools.map((tool) => tool.name)).toEqual(["dispatch_read", "team"]);
		expect(agent.skills).toEqual({ dir: "./skills" });
		expect("name" in agent).toBe(false);
	});
});
