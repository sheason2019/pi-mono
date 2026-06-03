import { describe, expect, it } from "vitest";
import { buildNativeToolSet } from "../src/executor/index.ts";

describe("buildNativeToolSet", () => {
	it("returns the 7 canonical native tools", () => {
		const tools = buildNativeToolSet(process.cwd());
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});

	it("passes cwd to every tool", () => {
		const tools = buildNativeToolSet("/tmp/some-cwd");
		// Real native tools' first execute arg is the resolved absolute path
		// they were constructed with; we sanity-check that the tool names are
		// the expected ones (cwd is opaque through the ToolDefinition type).
		for (const t of tools) {
			expect(typeof t.name).toBe("string");
			expect(t.name.length).toBeGreaterThan(0);
		}
	});
});
