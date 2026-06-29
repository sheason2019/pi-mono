import { describe, expect, it } from "vitest";
import { DPI_META_PROMPT } from "../src/dpi-meta.ts";

describe("DPI_META_PROMPT stays lean", () => {
	it("includes the d-pi self-identification header", () => {
		expect(DPI_META_PROMPT).toContain("d-pi runtime context");
	});

	it("embeds build commit and build time", () => {
		expect(DPI_META_PROMPT).toMatch(/commit=`[a-f0-9]+`/);
		expect(DPI_META_PROMPT).toMatch(/built=`\d{4}-\d{2}-\d{2}T/);
	});

	it("describes the d-pi runtime base and remote executor capability", () => {
		expect(DPI_META_PROMPT).toMatch(/agent base/i);
		expect(DPI_META_PROMPT).toMatch(/multiple.*agents/i);
		expect(DPI_META_PROMPT).toMatch(/long-lived/i);
		expect(DPI_META_PROMPT).toMatch(/executor/i);
		expect(DPI_META_PROMPT).toMatch(/remote/i);
	});

	it("keeps dispatch connect_id guidance minimal", () => {
		expect(DPI_META_PROMPT).toMatch(/dispatch tools/i);
		expect(DPI_META_PROMPT).toMatch(/omit\s+connect_id/i);
		expect(DPI_META_PROMPT).toMatch(/always required/i);
	});

	it("points agents to the source repository for deeper investigation", () => {
		expect(DPI_META_PROMPT).toMatch(/repository|source code/i);
		expect(DPI_META_PROMPT).toMatch(/investigat|debug|troubleshoot/i);
	});

	// === Drift regression ===

	it("does not mention the removed deliverAs term", () => {
		// deliverAs was renamed to mode in PR #29.
		expect(DPI_META_PROMPT).not.toMatch(/deliverAs/i);
	});

	// === Architectural contract: tool info must NOT live in the system prompt ===

	it("does not enumerate tool names (tools carry their own descriptions)", () => {
		// The previous prompt listed every d-pi tool with backticks; that
		// duplicated the tools API and drifted twice already (deliverAs,
		// slash-command claim). Tool details now live on the tools themselves.
		expect(DPI_META_PROMPT).not.toMatch(/`create_source`/);
		expect(DPI_META_PROMPT).not.toMatch(/`subscribe_source`/);
		expect(DPI_META_PROMPT).not.toMatch(/`create_agent`/);
		expect(DPI_META_PROMPT).not.toMatch(/`send_message`/);
		expect(DPI_META_PROMPT).not.toMatch(/`team`/);
		expect(DPI_META_PROMPT).not.toMatch(/`reload`/);
	});

	it("does not document cross-tool constraints inline (those belong on tools)", () => {
		// Per the architectural fix in this PR, mutex / mode / reload-limit
		// semantics belong on the respective tool's schema description, not
		// duplicated in DPI_META_PROMPT.
		expect(DPI_META_PROMPT).not.toMatch(/TUI Enter/i);
		expect(DPI_META_PROMPT).not.toMatch(/TUI Ctrl\+Enter/i);
		expect(DPI_META_PROMPT).not.toMatch(/includeTools.*excludeTools/s);
		expect(DPI_META_PROMPT).not.toMatch(/Does NOT re-parse/i);
	});

	it("does not mention the executor tool signature (lives on the executor)", () => {
		expect(DPI_META_PROMPT).not.toContain("toolCallId, params, signal, onUpdate, ctx");
	});

	it("does not enumerate TUI slash commands (those are user-facing, not LLM-facing)", () => {
		expect(DPI_META_PROMPT).not.toMatch(/`\/sources`/);
		expect(DPI_META_PROMPT).not.toMatch(/`\/agents`/);
	});

	it("does not include detailed orchestration guidance", () => {
		expect(DPI_META_PROMPT).not.toMatch(/Multi-agent behavior/);
		expect(DPI_META_PROMPT).not.toMatch(/Collaboration/);
		expect(DPI_META_PROMPT).not.toMatch(/Latency and freshness/);
		expect(DPI_META_PROMPT).not.toMatch(/createTime/);
		expect(DPI_META_PROMPT).not.toMatch(/dispatch_bash/);
	});
});
