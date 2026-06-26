import { describe, expect, it } from "vitest";
import { createTeamTool } from "../src/index.ts";

describe("team tool", () => {
	it("is named team", () => {
		const tool = createTeamTool();
		expect(tool.name).toBe("team");
		expect(tool.label).toBe("Team");
	});
});
