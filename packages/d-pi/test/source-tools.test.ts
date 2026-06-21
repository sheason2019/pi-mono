import { describe, expect, it } from "vitest";
import { createDeleteSourceTool, createGetSourceTool, createSetSourceTool } from "../src/index.ts";

describe("d-pi source tool surface", () => {
	it("exposes resource-style source tools as explicit agent.ts helpers and omits legacy source verbs", () => {
		const names = [createSetSourceTool(), createGetSourceTool(), createDeleteSourceTool()]
			.map((tool) => tool.name)
			.sort();

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
