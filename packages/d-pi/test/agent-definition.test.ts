import { describe, expect, it } from "vitest";
import {
	defineAgent,
	defineContextFile,
	defineContextFiles,
	defineModel,
	defineRole,
	defineRoles,
	defineSkill,
	defineTool,
	defineTools,
} from "../src/index.ts";

describe("agent definition helpers", () => {
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
