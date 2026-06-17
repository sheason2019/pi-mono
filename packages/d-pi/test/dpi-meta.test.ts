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

	// === Multi-agent orchestration guidance ===

	it("documents the multi-agent / long-lived lifecycle framing", () => {
		// The user explicitly asked for guidance that each agent is a
		// long-lived node in a larger tree, not a one-shot tool call.
		// If a future "lean it down" PR tries to remove this, the test
		// catches it.
		expect(DPI_META_PROMPT).toContain("Multi-agent behavior");
		expect(DPI_META_PROMPT).toMatch(/long-lived tree of agents/i);
		expect(DPI_META_PROMPT).toMatch(/orchestration cost/i);
	});

	it("encourages proactive collaboration and points at team for discovery", () => {
		// The user asked for two things in this section:
		//   1. Agents should reach out to peers proactively, not just react.
		//   2. Agents should use team to see who else is alive.
		expect(DPI_META_PROMPT).toContain("Collaboration");
		expect(DPI_META_PROMPT).toMatch(/proactively push results/i);
		expect(DPI_META_PROMPT).toMatch(/team/);
		// Sanity: still no backticks around the tool name.
		expect(DPI_META_PROMPT).not.toMatch(/`team`/);
	});

	it("warns about multi-agent dispatch latency and points at the meta createTime", () => {
		// The user observed that messages from peers / sources can be
		// minutes or hours old by the time they reach the agent, and
		// the LLM must not act on stale "current state" assertions.
		// The mechanism exposed for freshness checking is the
		// [meta(...)] header's createTime.
		expect(DPI_META_PROMPT).toContain("Latency and freshness");
		expect(DPI_META_PROMPT).toMatch(/not real-time/i);
		expect(DPI_META_PROMPT).toMatch(/createTime/);
		expect(DPI_META_PROMPT).toMatch(/\[meta\(\.\.\.\)\]/);
	});
});
