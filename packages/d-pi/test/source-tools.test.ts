import type { ExtensionAPI, ToolDefinition } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createMultiAgentExtension } from "../src/extension/index.ts";

function collectWorkerToolNames(): string[] {
	const tools: ToolDefinition[] = [];
	const { factory } = createMultiAgentExtension({
		mode: "worker",
		agentName: "root",
		postToHub: () => {},
	});
	const api = {
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	factory(api);
	return tools.map((tool) => tool.name).sort();
}

describe("d-pi source tool surface", () => {
	it("registers the resource-style source tools and omits legacy source verbs", () => {
		const names = collectWorkerToolNames();

		expect(names).toEqual(expect.arrayContaining(["set_source", "get_source", "delete_source"]));
		expect(names).not.toEqual(
			expect.arrayContaining([
				"create_source",
				"destroy_source",
				"list_sources",
				"subscribe_source",
				"unsubscribe_source",
			]),
		);
	});
});
