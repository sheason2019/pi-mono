import { describe, expect, it } from "vitest";
import { defineAgent, defineContextFile, defineModel, defineSkill, defineTool } from "../src/index.ts";

describe("agent definition helpers", () => {
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
