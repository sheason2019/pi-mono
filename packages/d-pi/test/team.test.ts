import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/contracts.ts";
import { createDPiExtension } from "../src/extension/index.ts";
import { createTeamTool } from "../src/index.ts";
import type { WorkerToHubMessage } from "../src/types.ts";

const fakeApi = {
	on: () => {},
	registerTool: () => {},
	registerMessageRenderer: () => {},
	sendMessage: () => {},
	registerCommand: () => {},
} as unknown as ExtensionAPI;

describe("team tool", () => {
	it("is named team", () => {
		const tool = createTeamTool();
		expect(tool.name).toBe("team");
		expect(tool.label).toBe("Team");
	});

	it("does not register LLM tools through the d-pi worker factory", () => {
		const registered: string[] = [];
		const commands: string[] = [];
		const postCalls: WorkerToHubMessage[] = [];
		const { factory } = createDPiExtension({
			mode: "worker",
			agentName: "agent-1",
			postToHub: (msg) => postCalls.push(msg),
		});
		const api = {
			...fakeApi,
			registerTool: (def: ToolDefinition) => {
				registered.push(def.name);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
		} as unknown as ExtensionAPI;

		factory(api);

		expect(registered).toEqual([]);
		expect(commands).toEqual(["sources", "agents"]);
	});
});
