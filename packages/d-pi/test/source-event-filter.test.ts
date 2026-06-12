import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

/**
 * Per-agent source-event allowlist tests.
 *
 * The allowlist resolves in this order:
 *   1. `agents/<name>/.d-pi-subscribed-events` (workspace-local
 *      dotfile; not in git because of the standard `agents/*`
 *      gitignore).
 *   2. `agents/<name>/agent.json`'s `subscribedEvents` field
 *      (committed with the agent).
 *   3. None of the above — the agent receives every event
 *      (backwards-compatible default).
 *
 * The literal `*` in either source means "subscribe to all
 * events" (provided for symmetry — the file is also allowed to
 * be absent or empty for the same effect).
 *
 * Filtering happens per-(source, agent) at broadcast time in
 * SourceManager._onLine. It's evaluated on every event so the
 * operator can edit the dotfile and the change takes effect
 * immediately on the next event without a hub restart.
 */
describe("per-agent source-event allowlist", () => {
	let broadcasts: Array<{ sourceName: string; line: string; agentIds: string[]; mode: string }>;
	let manager: SourceManager;
	let workspaceRoot: string;

	beforeEach(() => {
		broadcasts = [];
		workspaceRoot = mkdtempSync(join(tmpdir(), "d-pi-evt-filter-"));
		manager = new SourceManager(
			(sourceName, line, agentIds, mode) => {
				broadcasts.push({ sourceName, line, agentIds, mode });
			},
			{ workspaceRoot },
		);
	});

	afterEach(() => {
		manager.stopAll();
		rmSync(workspaceRoot, { recursive: true, force: true });
	});

	/** Drive a single source line through SourceManager._onLine. */
	function emitLine(line: string): void {
		// We have to go through createSource + a real subprocess to
		// exercise the full broadcast path. But for these tests we
		// only care about the filtering logic, not the bridge
		// round-trip. Reach into the private _onLine via a cast.
		(manager as unknown as { _onLine: (src: string, line: string) => void })._onLine("src", line);
	}

	/** Ensure the source record exists so subscribe() can add to it. */
	beforeEach(() => {
		// subscribe() throws if the source isn't registered. The
		// _onLine cast bypasses that path, but the real
		// subscribe() (used by the test's `subscribe(agentName)`)
		// needs the source record. Cheapest way: register a no-op
		// source. We use `sh -c 'sleep 9999'` so the subprocess
		// actually starts; for these tests it never produces output.
		manager.createSource(
			{
				name: "src",
				command: "sh",
				args: ["-c", "sleep 9999"],
			},
			"root",
		);
	});

	function makeAgentJson(name: string, subscribedEvents?: string[]): void {
		const dir = join(workspaceRoot, "agents", name);
		mkdirSync(dir, { recursive: true });
		const config: Record<string, unknown> = { name, parentName: null };
		if (subscribedEvents !== undefined) {
			config.subscribedEvents = subscribedEvents;
		}
		writeFileSync(join(dir, "agent.json"), JSON.stringify(config, null, "\t") + "\n");
	}

	function makeFile(name: string, contents: string): void {
		const dir = join(workspaceRoot, "agents", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".d-pi-subscribed-events"), contents);
	}

	/** Subscribe an agent to the source (mirrors what subscribe_source does). */
	function subscribe(agentName: string): void {
		manager.subscribe("src", agentName);
	}

	const receive = (chatId = "oc_abc"): string =>
		JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { type: "im.message.receive_v1", mode: "steer", data: { chat_id: chatId } },
		});
	const read = (): string =>
		JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: {
				type: "im.message.message_read_v1",
				mode: "steer",
				data: { message_id_list: ["om_xyz"] },
			},
		});
	const reaction = (): string =>
		JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { type: "im.message.reaction.created_v1", mode: "next", data: { reaction: "OK" } },
		});

	it("no allowlist anywhere — agent receives every event (backwards compat)", () => {
		makeAgentJson("root");
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		expect(broadcasts.length).toBe(3);
		for (const b of broadcasts) {
			expect(b.agentIds).toEqual(["root"]);
		}
	});

	it("only agent.json's subscribedEvents — drops events not in the list", () => {
		makeAgentJson("root", ["im.message.receive_v1"]);
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		// Only the receive_v1 line was broadcast; the other two
		// were dropped at the source-manager layer. The forwarded
		// body is the unwrapped data (the JSONRPC envelope has
		// already been stripped), so we identify events by the
		// shape of the body, not by the EventKey in the line.
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]?.agentIds).toEqual(["root"]);
		// receive_v1 had `data: { chat_id: 'oc_abc' }`.
		expect(broadcasts[0]?.line).toContain("oc_abc");
	});

	it("only the dotfile — drops events not in the file", () => {
		makeAgentJson("root"); // no subscribedEvents field
		makeFile("root", "im.message.receive_v1\n# comment line\n\n");
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]?.agentIds).toEqual(["root"]);
		expect(broadcasts[0]?.line).toContain("oc_abc");
	});

	it("dotfile is AUTHORITATIVE over agent.json — file's allowlist wins", () => {
		// agent.json says "subscribe to receive_v1 + reaction"; the
		// dotfile restricts to receive_v1 only. The file's
		// restriction must apply even if agent.json would have
		// allowed the event — the file is the local override the
		// operator dropped in specifically to narrow the rule.
		makeAgentJson("root", ["im.message.receive_v1", "im.message.reaction.created_v1"]);
		makeFile("root", "im.message.receive_v1\n");
		subscribe("root");
		emitLine(receive());
		emitLine(reaction());
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]?.line).toContain("oc_abc"); // receive, not reaction
	});

	it("dotfile with literal '*' means subscribe to all (matches agent.json shape)", () => {
		makeAgentJson("root");
		makeFile("root", "*\n");
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		expect(broadcasts.length).toBe(3);
	});

	it("empty dotfile is treated as 'zero events' (distinct from file absence)", () => {
		makeAgentJson("root"); // no subscribedEvents → would default to all
		makeFile("root", "# only comments here\n\n\n");
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		expect(broadcasts.length).toBe(0);
	});

	it("per-(source, agent) — one agent's allowlist doesn't affect another", () => {
		makeAgentJson("root", ["im.message.receive_v1"]);
		makeAgentJson("laptop", []); // empty array = explicit zero-events
		subscribe("root");
		subscribe("laptop");
		emitLine(receive());
		emitLine(read());
		// root only allows receive_v1; laptop explicitly wants zero.
		// So: nothing reaches laptop. The receive_v1 was filtered
		// to root only (which gets it), the read_v1 was filtered
		// to root only (which rejects it). laptop gets nothing
		// because it opted out of everything.
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]?.agentIds).toEqual(["root"]);
	});

	it("per-(source, agent) — laptop with '*' allowlist receives everything root filters out", () => {
		makeAgentJson("root", ["im.message.receive_v1"]);
		makeAgentJson("laptop", ["*"]);
		subscribe("root");
		subscribe("laptop");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		// Receive → both (root has it, laptop has *). Read →
		// laptop only. Reaction → laptop only. So 3 broadcasts
		// total — each event is broadcast once with the matching
		// subscriber list, not once per subscriber.
		expect(broadcasts.length).toBe(3);
		const byLine = new Map(broadcasts.map((b) => [b.line, b.agentIds.slice().sort()]));
		// receive line — broadcast with both root and laptop
		expect(byLine.get('{"chat_id":"oc_abc"}')).toEqual(["laptop", "root"]);
		// read line — root filters it out, laptop doesn't
		expect(byLine.get('{"message_id_list":["om_xyz"]}')).toEqual(["laptop"]);
		// reaction line — root filters it out, laptop doesn't
		expect(byLine.get('{"reaction":"OK"}')).toEqual(["laptop"]);
	});

	it("changes to the dotfile take effect on the very next event (no hub restart)", () => {
		makeAgentJson("root");
		makeFile("root", "im.message.receive_v1\n");
		subscribe("root");
		// First event: only receive_v1 allowed.
		emitLine(receive());
		emitLine(reaction());
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]?.line).toContain("oc_abc");
		// Operator changes their mind — overwrite the dotfile.
		makeFile("root", "im.message.reaction.created_v1\n");
		// Next event: only reaction allowed.
		emitLine(receive());
		emitLine(reaction());
		// Total: 1 (receive) + 1 (reaction) = 2. NOT 3 because
		// the second receive was filtered under the new file.
		expect(broadcasts.length).toBe(2);
		// First was a receive; second was a reaction.
		expect(broadcasts[0]?.line).toContain("oc_abc");
		expect(broadcasts[1]?.line).toContain("OK");
	});

	it("an agent whose allowlist excludes every event in the source still gets nothing (silently dropped)", () => {
		makeAgentJson("root", ["nonexistent.event.type"]);
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		expect(broadcasts.length).toBe(0);
	});

	it("agent.json subscribedEvents: ['*'] is treated the same as omitted", () => {
		makeAgentJson("root", ["*"]);
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		expect(broadcasts.length).toBe(2);
	});

	it("agent.json subscribedEvents: [] is treated as zero events", () => {
		makeAgentJson("root", []);
		subscribe("root");
		emitLine(receive());
		emitLine(read());
		emitLine(reaction());
		expect(broadcasts.length).toBe(0);
	});

	it("source line without a params.type still gets broadcast (no filtering possible)", () => {
		// Defensive: if the bridge ever sends a malformed line
		// without a type, we don't try to filter it (we'd have no
		// key to compare against) — it just goes to every
		// subscriber.
		makeAgentJson("root", ["im.message.receive_v1"]);
		subscribe("root");
		const typeless = JSON.stringify({
			jsonrpc: "2.0",
			method: "events.emit",
			params: { data: "no type field here" },
		});
		emitLine(typeless);
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]?.agentIds).toEqual(["root"]);
	});
});

// Cross-check: make sure the agent-identity helper (the one this
// PR adds in agent-identity.ts) parses the same file format that
// source-manager uses. They should agree; if they ever drift, the
// LLM will see "you subscribe to X" while the hub actually drops X
// — a confusing UX that this test would catch.
describe("agent-identity readSubscribedEventsFile agrees with source-manager's filter", () => {
	it("parses the same comments + whitespace + dedup as source-manager", async () => {
		const { readSubscribedEventsFile } = await import("../src/hub/agent-identity.ts");
		const wsRoot = mkdtempSync(join(tmpdir(), "d-pi-evt-cross-"));
		try {
			const dir = join(wsRoot, "agents", "root");
			mkdirSync(dir, { recursive: true });
			const fileContents = [
				"# This is a comment",
				"",
				"im.message.receive_v1",
				"  im.message.reaction.created_v1  ", // leading/trailing whitespace
				"# another comment",
				"im.message.receive_v1", // duplicate; Set handles this
			].join("\n");
			writeFileSync(join(dir, ".d-pi-subscribed-events"), fileContents);
			const result = readSubscribedEventsFile(dir);
			expect(result).not.toBeNull();
			expect(result?.has("im.message.receive_v1")).toBe(true);
			expect(result?.has("im.message.reaction.created_v1")).toBe(true);
			// Set semantics: duplicate line counts once.
			expect(result?.size).toBe(2);
		} finally {
			rmSync(wsRoot, { recursive: true, force: true });
		}
	});

	it("file containing literal '*' (with other entries) short-circuits to the star Set", async () => {
		const { readSubscribedEventsFile } = await import("../src/hub/agent-identity.ts");
		const wsRoot = mkdtempSync(join(tmpdir(), "d-pi-evt-cross-"));
		try {
			const dir = join(wsRoot, "agents", "root");
			mkdirSync(dir, { recursive: true });
			// Star mixed with other entries — per the docstring, the
			// helper short-circuits to the literal-star Set the moment
			// it sees a "*" line. Subsequent lines are still parsed
			// (no early return in the source code), but the Set
			// already has "*" so anything added afterwards is
			// irrelevant.
			const fileContents = ["# comment", "im.message.receive_v1", "*", "im.message.reaction.created_v1"].join("\n");
			writeFileSync(join(dir, ".d-pi-subscribed-events"), fileContents);
			const result = readSubscribedEventsFile(dir);
			expect(result).not.toBeNull();
			expect(result?.has("*")).toBe(true);
		} finally {
			rmSync(wsRoot, { recursive: true, force: true });
		}
	});
});
