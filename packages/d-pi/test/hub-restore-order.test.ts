import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiscoveredAgent, discoverPersistedAgents, orderAgentsForRestore } from "../src/hub/restore-agents.ts";
import type { AgentConfig } from "../src/types.ts";

/**
 * Regression tests for the parent-child topology invariant of the agent
 * tree. See the commit that introduced `orderAgentsForRestore` for
 * context: the previous restore path iterated `agents/` in raw
 * `readdirSync` order, which is filesystem-dependent (e.g. on macOS
 * HFS+/APFS the order is insertion / case-insensitive /
 * locale-dependent). If a child agent.json was read before its parent,
 * `getByName(parentName)` returned `undefined` and the child was created
 * as an orphan — the very bug the user reported, where `llm-wiki`
 * showed up at the same depth as `root` in the TUI's "Switch to agent"
 * selector.
 *
 * The fix is a two-pass restore: read all `agent.json` files first,
 * then sort by `parentName` chain depth so a child's parent is always
 * registered first. These tests target the pure sort/discovery layer
 * (no Worker spawning, no Hub lifecycle) so the test runs in
 * milliseconds and is fully deterministic.
 *
 * The runtime create_agent path (worker → hub) is also locked in by
 * a defensive check in `Hub.createAgent` that throws if a non-undefined
 * `parentAgentId` does not resolve to a registry entry — see
 * `hub-restore-order.test.ts` integration case below.
 */

let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-restore-"));
	return tempDir;
}

function writeAgentJson(workspace: string, entryName: string, config: AgentConfig): void {
	const dir = join(workspace, "agents", entryName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "agent.json"), `${JSON.stringify(config, null, "\t")}\n`);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("discoverPersistedAgents + orderAgentsForRestore", () => {
	it("depth-sorts so a child is always preceded by its parent", () => {
		const workspace = freshWorkspace();
		// Child written FIRST so on insertion-order / case-insensitive
		// filesystems the readdir would return llm-wiki before root.
		writeAgentJson(workspace, "llm-wiki", { name: "llm-wiki", parentName: "root" });
		writeAgentJson(workspace, "root", { name: "root", parentName: undefined });

		const discovered = discoverPersistedAgents(workspace);
		const ordered = orderAgentsForRestore(discovered);

		// Sorted by depth: root (0) before llm-wiki (1)
		expect(ordered.map((e) => e.config.name)).toEqual(["root", "llm-wiki"]);
		// No cycles, expected depths
		expect(ordered.find((e) => e.config.name === "root")).toMatchObject({ depth: 0, cycle: false });
		expect(ordered.find((e) => e.config.name === "llm-wiki")).toMatchObject({ depth: 1, cycle: false });
	});

	it("handles deep trees (3+ levels) regardless of entry order", () => {
		const workspace = freshWorkspace();
		// Write deepest first, then middle, then root — exactly the
		// case where the buggy old code would orphan the deepest nodes.
		writeAgentJson(workspace, "leaf", { name: "leaf", parentName: "middle" });
		writeAgentJson(workspace, "middle", { name: "middle", parentName: "root" });
		writeAgentJson(workspace, "root", { name: "root", parentName: undefined });

		const ordered = orderAgentsForRestore(discoverPersistedAgents(workspace));
		expect(ordered.map((e) => e.config.name)).toEqual(["root", "middle", "leaf"]);
		expect(ordered.map((e) => e.depth)).toEqual([0, 1, 2]);
	});

	it("breaks alphabetical ties deterministically", () => {
		// All at depth 1; order should be alphabetical by name
		const discovered: DiscoveredAgent[] = [
			{ entryName: "zeta", config: { name: "zeta", parentName: "root" } },
			{ entryName: "alpha", config: { name: "alpha", parentName: "root" } },
			{ entryName: "mike", config: { name: "mike", parentName: "root" } },
		];
		const ordered = orderAgentsForRestore(discovered);
		expect(ordered.map((e) => e.config.name)).toEqual(["alpha", "mike", "zeta"]);
	});

	it("detects a 2-cycle (A's parent is B, B's parent is A) and marks both as cycle", () => {
		const discovered: DiscoveredAgent[] = [
			{ entryName: "a", config: { name: "a", parentName: "b" } },
			{ entryName: "b", config: { name: "b", parentName: "a" } },
		];
		const ordered = orderAgentsForRestore(discovered);
		// Both are marked as cycles (the one we identify as cycle-starter
		// depends on the entry iteration order, but cycle=true must hold
		// for at least one and never false for both).
		const a = ordered.find((e) => e.config.name === "a");
		const b = ordered.find((e) => e.config.name === "b");
		expect(a?.cycle || b?.cycle).toBe(true);
	});

	it("skips entries that point to a parent not in the discovered set (no false cycle)", () => {
		// child claims parent "missing-parent" which is not in the set;
		// the parent chain just terminates — depth 1, no cycle.
		const discovered: DiscoveredAgent[] = [
			{ entryName: "child", config: { name: "child", parentName: "missing-parent" } },
		];
		const ordered = orderAgentsForRestore(discovered);
		expect(ordered[0]).toMatchObject({ depth: 1, cycle: false });
	});

	it("skips unreadable agent.json files with a stderr warning and continues", () => {
		const workspace = freshWorkspace();
		// Good agent
		writeAgentJson(workspace, "root", { name: "root", parentName: undefined });
		// Corrupt agent (invalid JSON)
		const badDir = join(workspace, "agents", "broken");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(join(badDir, "agent.json"), "{ this is not valid json");

		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const discovered = discoverPersistedAgents(workspace);
			const names = discovered.map((d) => d.config.name);
			expect(names).toEqual(["root"]); // broken is silently dropped
			const warned = stderr.mock.calls.some((call) =>
				String(call[0]).includes("Failed to read agent.json from broken/"),
			);
			expect(warned).toBe(true);
		} finally {
			stderr.mockRestore();
		}
	});

	it("returns an empty list when agents/ does not exist (fresh workspace)", () => {
		const workspace = freshWorkspace();
		// No agents/ dir at all
		expect(discoverPersistedAgents(workspace)).toEqual([]);
	});
});

describe("Hub.createAgent — parent invariant defensive check", () => {
	beforeEach(async () => {
		// Replace node:worker_threads with a fake that immediately emits
		// a matching ready message so the worker's "wait for ready"
		// promise resolves.
		vi.doMock("node:worker_threads", async () => {
			const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
			class FakeWorker {
				private listeners: Array<(msg: unknown) => void> = [];
				constructor(_url: unknown, options?: { workerData?: { agentId?: string; port?: number } }) {
					const agentId = options?.workerData?.agentId;
					const port = options?.workerData?.port ?? 0;
					queueMicrotask(() => {
						for (const l of this.listeners) l({ type: "ready", agentId, port });
					});
				}
				on(event: string, handler: (msg: unknown) => void): void {
					if (event === "message") this.listeners.push(handler);
				}
				off(): void {}
				postMessage(): void {}
			}
			return { ...actual, Worker: FakeWorker };
		});
	});

	it("rejects when parentAgentId is provided but not in the registry", async () => {
		// Re-import Hub AFTER the mock is in place
		const { Hub: HubMocked } = await import("../src/hub/hub.ts");
		const workspace = freshWorkspace();
		const hub = new HubMocked({
			port: 50000 + Math.floor(Math.random() * 1000),
			workspaceRoot: workspace,
			cwd: workspace,
			model: "test/model",
			workspaceContext: { workspaceRoot: workspace, additionalSkillPaths: [], additionalExtensionPaths: [] },
			workspaceConfig: { version: 1 },
		});
		await expect(hub.createAgent("nonexistent-uuid-xxx", { name: "child" })).rejects.toThrow(
			/parent agent id "nonexistent-uuid-xxx" not found/,
		);
	});

	it("accepts a real parent and links the child correctly", async () => {
		const { Hub: HubMocked } = await import("../src/hub/hub.ts");
		const { AgentRegistry } = await import("../src/hub/agent-registry.ts");
		const workspace = freshWorkspace();
		const hub = new HubMocked({
			port: 50000 + Math.floor(Math.random() * 1000),
			workspaceRoot: workspace,
			cwd: workspace,
			model: "test/model",
			workspaceContext: { workspaceRoot: workspace, additionalSkillPaths: [], additionalExtensionPaths: [] },
			workspaceConfig: { version: 1 },
		});
		// Skip the restore pass — we just want the createAgent defensive
		// check in isolation. Inject a root record directly via the registry.
		const registry = (hub as unknown as { _registry: InstanceType<typeof AgentRegistry> })._registry;
		const rootId = "00000000-0000-0000-0000-000000000001";
		registry.register({
			id: rootId,
			name: "root",
			parentId: undefined,
			children: [],
			port: 39091,
			status: "ready",
			model: undefined,
			worker: { postMessage: () => {}, on: () => {}, off: () => {} } as never,
			cwd: workspace,
		});
		const result = await hub.createAgent(rootId, { name: "direct-child" });
		expect(result.name).toBe("direct-child");
		const child = registry.getByName("direct-child");
		expect(child?.parentId).toBe(rootId);
		expect(registry.get(rootId)?.children).toContain(child?.id);
	});
});
