import { describe, expect, it } from "vitest";
import { normalizeLoadedAgentDefinition } from "../src/agent-loader.ts";
import {
	defineAgent,
	defineContextFile,
	defineModel,
	defineSkill,
	defineTool,
	defineTuiComponent,
} from "../src/index.ts";

describe("agent definition helpers", () => {
	it("builds a normalized agent definition without a stored name", () => {
		const component = defineTuiComponent({
			customType: "d-pi-message",
			render: () => undefined,
		});
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
			tuiComponents: [component],
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
		expect(agent.tuiComponents).toEqual([component]);
		expect(agent.skills).toEqual({ dir: "./skills" });
		expect(agent.contextFiles).toEqual([
			{ type: "context", path: "./AGENTS.md" },
			{ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" },
		]);
		expect("name" in agent).toBe(false);
	});

	it("normalizes agent definitions with tui components", () => {
		const render = () => undefined;

		const loaded = normalizeLoadedAgentDefinition("/tmp/workspace/agents/root/agent.ts", {
			skills: defineSkill({ dir: "./skills" }),
			tools: [],
			tuiComponents: [defineTuiComponent({ customType: "d-pi-message", render })],
			contextFiles: [],
		});

		expect(loaded.tuiComponents).toEqual([{ customType: "d-pi-message", render }]);
	});

	it("rejects invalid tui component definitions", () => {
		const base = {
			skills: defineSkill({ dir: "./skills" }),
			tools: [],
			contextFiles: [],
		};

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/root/agent.ts", {
				...base,
				tuiComponents: [{ customType: 1, render: () => undefined }],
			}),
		).toThrow("Agent definition tuiComponents[0].customType must be a string");

		expect(() =>
			normalizeLoadedAgentDefinition("/tmp/workspace/agents/root/agent.ts", {
				...base,
				tuiComponents: [{ customType: "d-pi-message", render: "not a function" }],
			}),
		).toThrow("Agent definition tuiComponents[0].render must be a function");
	});
});
