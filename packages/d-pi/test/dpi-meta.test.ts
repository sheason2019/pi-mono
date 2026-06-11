import { describe, expect, it } from "vitest";
import { DPI_META_PROMPT } from "../src/dpi-meta.ts";

describe("d-pi meta prompt", () => {
	it("includes the d-pi self-identification", () => {
		expect(DPI_META_PROMPT).toContain("d-pi runtime context");
	});

	it("lists every d-pi tool by name", () => {
		const tools = [
			"create_source",
			"destroy_source",
			"list_sources",
			"subscribe_source",
			"unsubscribe_source",
			"create_agent",
			"destroy_agent",
			"send_message",
			"group_architecture",
			"reload",
		];
		for (const t of tools) {
			expect(DPI_META_PROMPT, `missing tool: ${t}`).toContain(`\`${t}\``);
		}
	});

	it("links to the d-pi source", () => {
		expect(DPI_META_PROMPT).toContain("https://github.com/sheason2019/pi-mono");
	});

	it("embeds build commit and build time", () => {
		expect(DPI_META_PROMPT).toMatch(/commit=`[a-f0-9]+`/);
		expect(DPI_META_PROMPT).toMatch(/built=`\d{4}-\d{2}-\d{2}T/);
	});
});
