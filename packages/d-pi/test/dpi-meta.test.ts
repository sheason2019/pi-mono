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

	// === Accuracy regression tests (added when fixing prompt drift) ===

	it("does not mention the removed deliverAs term", () => {
		// deliverAs was renamed to mode in PR #29. Any reappearance in
		// the prompt would mislead the agent.
		expect(DPI_META_PROMPT).not.toMatch(/deliverAs/i);
	});

	it("documents send_message mode semantics aligned with TUI", () => {
		// Agents should know `next` ≈ TUI Enter, `steer` ≈ TUI Ctrl+Enter.
		expect(DPI_META_PROMPT).toContain("next");
		expect(DPI_META_PROMPT).toContain("steer");
		expect(DPI_META_PROMPT).toContain("TUI Enter");
		expect(DPI_META_PROMPT).toContain("TUI Ctrl+Enter");
	});

	it("documents the create_agent includeTools/excludeTools mutex", () => {
		expect(DPI_META_PROMPT).toContain("includeTools");
		expect(DPI_META_PROMPT).toContain("excludeTools");
		expect(DPI_META_PROMPT).toMatch(/both.*rejected|passing\s+BOTH/i);
	});

	it("documents the reload limitations (no agent.json / role reload)", () => {
		expect(DPI_META_PROMPT).toContain("Does NOT re-parse");
		expect(DPI_META_PROMPT).toContain("agent.json");
		expect(DPI_META_PROMPT).toMatch(/hub restart/);
	});

	it("lists only the real TUI slash commands (/sources and /agents)", () => {
		// The previous prompt falsely claimed "slash-command interface
		// mirroring each d-pi tool" — only /sources and /agents are
		// registered (see packages/d-pi/src/extension/index.ts).
		expect(DPI_META_PROMPT).toContain("`/sources`");
		expect(DPI_META_PROMPT).toContain("`/agents`");
	});

	it("documents the executor tool signature", () => {
		expect(DPI_META_PROMPT).toContain("(toolCallId, params, signal, onUpdate, ctx)");
	});
});
