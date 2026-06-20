import { describe, expect, it } from "vitest";
import {
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
	defineTool,
	defineTools,
} from "../src/index.ts";

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

	it("composes associated resource helpers into an agent definition", () => {
		const agent = defineAgent({
			description: "resource-rich",
			roles: defineRoles(defineRole("planner"), defineRole("reviewer")),
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: defineTools(defineTool({ name: "dispatch_read" }), defineTool({ name: "team" })),
			contextFiles: defineContextFiles(
				defineContextFile({ type: "context", path: "./AGENTS.md" }),
				defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),
			),
		});

		expect(agent.roles).toEqual(["planner", "reviewer"]);
		expect(agent.model).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
		expect(agent.tools).toEqual([{ name: "dispatch_read" }, { name: "team" }]);
		expect(agent.contextFiles).toEqual([
			{ type: "context", path: "./AGENTS.md" },
			{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
		]);
	});

	it("normalizes omitted resource fields to stable defaults", () => {
		const agent = defineAgent({
			description: "minimal",
		});

		expect(agent).toEqual({
			description: "minimal",
			tools: [],
			skills: { dir: "./skills" },
			contextFiles: [
				{ type: "context", path: "./AGENTS.md" },
				{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
			],
		});
	});

	it("copies arrays and nested definitions so caller mutation cannot change the definition", () => {
		const roles = ["reviewer"];
		const tools = [defineTool({ name: "dispatch_read" })];
		const contextFiles = [defineContextFile({ type: "context", path: "./AGENTS.md" })];
		const agent = defineAgent({
			roles,
			tools,
			contextFiles,
			skills: defineSkill({ dir: "./skills" }),
		});

		roles.push("mutated");
		tools.push(defineTool({ name: "dispatch_write" }));
		contextFiles[0] = defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" });

		expect(agent.roles).toEqual(["reviewer"]);
		expect(agent.tools).toEqual([{ name: "dispatch_read" }]);
		expect(agent.contextFiles).toEqual([{ type: "context", path: "./AGENTS.md" }]);
	});

	it("builds a normalized agent definition without a stored name", () => {
		const parent = defineAgent({
			description: "root",
			roles: [],
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: [defineTool({ name: "team" })],
			contextFiles: [],
		});
		const agent = defineAgent({
			parent,
			description: "reviewer",
			roles: ["reviewer"],
			model: defineModel({ provider: "anthropic", name: "claude-sonnet-4" }),
			skills: defineSkill({ dir: "./skills" }),
			tools: [defineTool({ name: "dispatch_read" }), defineTool({ name: "team" })],
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
