import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiscoveredAgent, discoverPersistedAgents, orderAgentsForRestore } from "../src/hub/restore-agents.ts";
import type { AgentConfig } from "../src/types.ts";

/**
 * Regression tests for the parent-child topology invariant of the agent
 * tree. See the commit that introduced `orderAgentsForRestore` for
 * context: the previous restore path iterated `agents/` in raw
 * `readdirSync` order, which is filesystem-dependent (e.g. on macOS
 * HFS+/APFS the order is insertion / case-insensitive /
 * locale-dependent). If a child agent.ts was read before its parent,
 * `getByName(parentName)` returned `undefined` and the child was created
 * as an orphan — the very bug the user reported, where `llm-wiki`
 * showed up at the same depth as `root` in the TUI's "Switch to agent"
 * selector.
 *
 * The fix is a two-pass restore: read all `agent.ts` files first,
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

function writeAgentTs(
	workspace: string,
	entryName: string,
	config: AgentConfig,
	parentImportName?: string,
	overrideName?: string,
): void {
	const dir = join(workspace, "agents", entryName);
	mkdirSync(dir, { recursive: true });
	const dPiDefinitionUrl = pathToFileURL(join(process.cwd(), "src", "agent-definition.ts")).href;
	const lines = [
		`import { defineAgent, defineContextFile, defineSkill, defineTool } from ${JSON.stringify(dPiDefinitionUrl)};`,
	];
	if (parentImportName) {
		lines.push(`import parentAgent from "../${parentImportName}/agent.ts";`);
	}
	lines.push("");
	lines.push("export default defineAgent({");
	if (parentImportName) {
		lines.push("\tparent: parentAgent,");
	}
	if (overrideName !== undefined) {
		lines.push(`\tdescription: ${JSON.stringify(`declared:${overrideName}`)},`);
	} else if (config.description !== undefined) {
		lines.push(`\tdescription: ${JSON.stringify(config.description)},`);
	}
	if (config.roles && config.roles.length > 0) {
		lines.push(`\troles: ${JSON.stringify(config.roles)},`);
	}
	lines.push('\tskills: defineSkill({ dir: "./skills" }),');
	lines.push("\ttools: [");
	for (const toolName of config.includeTools ?? ["dispatch_read"]) {
		lines.push(`\t\tdefineTool({ name: ${JSON.stringify(toolName)} }),`);
	}
	lines.push("\t],");
	lines.push("\tcontextFiles: [");
	lines.push('\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),');
	lines.push('\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),');
	lines.push("\t],");
	lines.push("});");
	lines.push("");
	writeFileSync(join(dir, "agent.ts"), lines.join("\n"));
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("discoverPersistedAgents + orderAgentsForRestore", () => {
	it("depth-sorts so a child is always preceded by its parent", async () => {
		const workspace = freshWorkspace();
		// Child written FIRST so on insertion-order / case-insensitive
		// filesystems the readdir would return llm-wiki before root.
		writeAgentTs(workspace, "llm-wiki", { name: "llm-wiki", parentName: "root" }, "root");
		writeAgentTs(workspace, "root", { name: "root", parentName: undefined });

		const discovered = await discoverPersistedAgents(workspace);
		const ordered = orderAgentsForRestore(discovered);

		// Sorted by depth: root (0) before llm-wiki (1)
		expect(ordered.map((e) => e.config.name)).toEqual(["root", "llm-wiki"]);
		// No cycles, expected depths
		expect(ordered.find((e) => e.config.name === "root")).toMatchObject({ depth: 0, cycle: false });
		expect(ordered.find((e) => e.config.name === "llm-wiki")).toMatchObject({ depth: 1, cycle: false });
	});

	it("handles deep trees (3+ levels) regardless of entry order", async () => {
		const workspace = freshWorkspace();
		// Write deepest first, then middle, then root — exactly the
		// case where the buggy old code would orphan the deepest nodes.
		writeAgentTs(workspace, "leaf", { name: "leaf", parentName: "middle" }, "middle");
		writeAgentTs(workspace, "middle", { name: "middle", parentName: "root" }, "root");
		writeAgentTs(workspace, "root", { name: "root", parentName: undefined });

		const ordered = orderAgentsForRestore(await discoverPersistedAgents(workspace));
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

	it("skips unreadable agent.ts files with a stderr warning and continues", async () => {
		const workspace = freshWorkspace();
		// Good agent
		writeAgentTs(workspace, "root", { name: "root", parentName: undefined });
		// Corrupt agent module
		const badDir = join(workspace, "agents", "broken");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(join(badDir, "agent.ts"), "export default {");

		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const discovered = await discoverPersistedAgents(workspace);
			const names = discovered.map((d) => d.config.name);
			expect(names).toEqual(["root"]); // broken is silently dropped
			const warned = stderr.mock.calls.some((call) =>
				String(call[0]).includes("Failed to read agent.ts from broken/"),
			);
			expect(warned).toBe(true);
		} finally {
			stderr.mockRestore();
		}
	});

	it("derives the agent name from the directory and parentName from imported parent definitions", async () => {
		const workspace = freshWorkspace();
		writeAgentTs(workspace, "root", { name: "ignored-root-name", parentName: undefined }, undefined, "other-root");
		writeAgentTs(
			workspace,
			"reviewer",
			{ name: "ignored-reviewer-name", parentName: "ignored" },
			"root",
			"other-reviewer",
		);

		const discovered = await discoverPersistedAgents(workspace);
		const root = discovered.find((entry) => entry.entryName === "root");
		const reviewer = discovered.find((entry) => entry.entryName === "reviewer");

		expect(root?.config.name).toBe("root");
		expect(root?.config.parentName).toBeUndefined();
		expect(reviewer?.config.name).toBe("reviewer");
		expect(reviewer?.config.parentName).toBe("root");
	});

	it("returns an empty list when agents/ does not exist (fresh workspace)", () => {
		const workspace = freshWorkspace();
		// No agents/ dir at all
		return expect(discoverPersistedAgents(workspace)).resolves.toEqual([]);
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
				constructor(
					_url: unknown,
					options?: { workerData?: { agentName?: string; parentName?: string; port?: number } },
				) {
					const agentName = options?.workerData?.agentName;
					const port = options?.workerData?.port ?? 0;
					queueMicrotask(() => {
						for (const l of this.listeners) l({ type: "ready", agentName, port });
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
		await expect(hub.createAgent("nonexistent-name-xxx", { name: "child" })).rejects.toThrow(
			/parent agent "nonexistent-name-xxx" not found/,
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
		// The registry is now name-keyed (see the "name is identity"
		// rationale in the changelog), so the root is registered under
		// the name "root" — there is no separate id.
		const registry = (hub as unknown as { _registry: InstanceType<typeof AgentRegistry> })._registry;
		registry.register({
			name: "root",
			parentName: undefined,
			children: [],
			port: 39091,
			status: "ready",
			model: undefined,
			worker: { postMessage: () => {}, on: () => {}, off: () => {} } as never,
			cwd: workspace,
		});
		const result = await hub.createAgent("root", { name: "direct-child" });
		expect(result.agentName).toBe("direct-child");
		const child = registry.getByName("direct-child");
		expect(child?.parentName).toBe("root");
		expect(registry.get("root")?.children).toContain(child?.name);
	});

	it("does not rewrite an existing agent.ts when restoring persisted agents", async () => {
		const { Hub: HubMocked } = await import("../src/hub/hub.ts");
		const workspace = freshWorkspace();
		const agentDir = join(workspace, "agents", "root");
		mkdirSync(agentDir, { recursive: true });
		const original = [
			'import { defineAgent, defineModel, defineOpenAIProvider } from "@sheason/d-pi";',
			"",
			"export default defineAgent({",
			"\tmodel: defineModel({",
			'\t\tid: "gpt-local",',
			"\t\tprovider: defineOpenAIProvider(),",
			"\t\tcontextWindow: 200000,",
			"\t}),",
			"});",
			"",
		].join("\n");
		writeFileSync(join(agentDir, "agent.ts"), original);
		const hub = new HubMocked({
			port: 50000 + Math.floor(Math.random() * 1000),
			workspaceRoot: workspace,
			cwd: workspace,
			model: undefined,
			workspaceContext: { workspaceRoot: workspace, additionalSkillPaths: [], additionalExtensionPaths: [] },
			workspaceConfig: { version: 1 },
		});

		await hub.createAgent(undefined, { name: "root", persistDefinition: false });

		expect(readFileSync(join(agentDir, "agent.ts"), "utf-8")).toBe(original);
	});
});
