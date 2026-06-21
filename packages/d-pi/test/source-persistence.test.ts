import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";
import type { SourceConfigFile } from "../src/hub/source-persistence.ts";
import {
	deleteSourceConfig,
	discoverSourceConfigs,
	sourceConfigFileToConfig,
	writeSourceConfig,
} from "../src/hub/source-persistence.ts";
import type { SourceConfig } from "../src/types.ts";

type StderrWriteCall = [string | Uint8Array, BufferEncoding?, ((err?: Error) => void)?];

/**
 * Tests for the `sources/<name>/source.json` persistence layer.
 *
 * Covers:
 * - writeSourceConfig / deleteSourceConfig / discoverSourceConfigs
 *   round-trip
 * - SourceManager writes a source.json on setSource
 * - SourceManager deletes the source.json on deleteSource
 * - SourceManager updates (setSource/removeAgentSubscriptions)
 *   rewrite the file with the new subscribers set
 * - restoreFromConfigs re-spawns the process and re-subscribes only
 *   the agents that are still alive in the live set
 *
 * The subprocess is stubbed via vi.mock("node:child_process", ...) at
 * the top of the file so no real process is started; the supervisor
 * just stores the (fake) child reference and the tests don't drive
 * the supervisor's restart loop.
 */
let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-source-persist-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
	vi.clearAllMocks();
});

/**
 * Mock `node:child_process` so `spawn` returns an EventEmitter that
 * pretends to be a ChildProcess. The SourceManager's `_spawnProcess`
 * pipes stdout/stderr through `createInterface({ input: stream })`,
 * which the bare EventEmitter can't satisfy — but those calls throw
 * silently inside a try-less path and the tests don't read any
 * stream output. We just need the supervisor to NOT try to start
 * a real node process during a unit test.
 */
vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	const { PassThrough } = await import("node:stream");
	return {
		...actual,
		spawn: vi.fn(() => {
			// Build a fake ChildProcess with PassThrough stdio streams.
			// The SourceManager pipes stdout/stderr through readline, which
			// needs a stream with .resume() / .on('line') — PassThrough
			// satisfies that. The exit/error handlers never fire in tests
			// because we don't drive the supervisor.
			const fake = {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				stdin: new PassThrough(),
				pid: 99999,
				killed: false,
				kill: vi.fn(),
				on: vi.fn(),
				once: vi.fn(),
				emit: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				removeAllListeners: vi.fn(),
				listeners: vi.fn(() => []),
			} as unknown as import("node:child_process").ChildProcess;
			return fake;
		}),
	};
});

describe("source-persistence pure helpers", () => {
	it("round-trips a SourceConfigFile through write → discover", () => {
		const workspace = freshWorkspace();
		const input: SourceConfigFile = {
			name: "lark-bot",
			command: "node",
			args: ["path/to/bridge.js"],
			cwd: undefined,
			env: { LARK_APP_ID: "cli_x" },
			subscribers: ["router", "logger"],
			creatorName: "router",
		};
		writeSourceConfig(workspace, input);

		const files = discoverSourceConfigs(workspace);
		expect(files).toHaveLength(1);
		const file = files[0]!;
		expect(file).toEqual(input);
	});

	it("returns an empty list when sources/ does not exist", () => {
		const workspace = freshWorkspace();
		expect(discoverSourceConfigs(workspace)).toEqual([]);
	});

	it("deleteSourceConfig removes the directory", () => {
		const workspace = freshWorkspace();
		writeSourceConfig(workspace, {
			name: "x",
			command: "y",
			args: [],
			cwd: undefined,
			env: undefined,
			subscribers: [],
		});
		expect(discoverSourceConfigs(workspace)).toHaveLength(1);
		deleteSourceConfig(workspace, "x");
		expect(discoverSourceConfigs(workspace)).toEqual([]);
		// Idempotent
		deleteSourceConfig(workspace, "x");
	});

	it("skips corrupt source.json files with a stderr warning and continues", () => {
		const workspace = freshWorkspace();
		// Good file
		writeSourceConfig(workspace, {
			name: "good",
			command: "y",
			args: [],
			cwd: undefined,
			env: undefined,
			subscribers: [],
		});
		// Corrupt file in a separate directory
		const badDir = join(workspace, "sources", "bad");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(join(badDir, "source.json"), "{ this is not valid");

		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const files = discoverSourceConfigs(workspace);
			expect(files.map((f) => f.name)).toEqual(["good"]);
			const warned = stderr.mock.calls.some((call: StderrWriteCall) =>
				String(call[0]).includes("Failed to parse source.json"),
			);
			expect(warned).toBe(true);
		} finally {
			stderr.mockRestore();
		}
	});

	it("sourceConfigFileToConfig strips persistence-only fields", () => {
		const config: SourceConfig = sourceConfigFileToConfig({
			name: "lark-bot",
			command: "node",
			args: ["x.js"],
			cwd: undefined,
			env: { K: "V" },
			subscribers: ["a", "b"], // stripped
			creatorName: "a", // stripped
		});
		expect(config).toEqual({
			name: "lark-bot",
			command: "node",
			args: ["x.js"],
			cwd: undefined,
			env: { K: "V" },
		});
	});
});

describe("SourceManager persistence integration", () => {
	it("setSource creates by name and persists explicit subscribers", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource(
			{
				name: "lark-bot",
				command: "node",
				args: ["bridge.js"],
				cwd: undefined,
				env: { LARK_APP_ID: "cli_x" },
				subscribers: ["router", "logger"],
			},
			"creator",
		);

		const files = discoverSourceConfigs(workspace);
		expect(files).toHaveLength(1);
		const file = files[0]!;
		expect(file.name).toBe("lark-bot");
		expect(file.command).toBe("node");
		expect(file.subscribers).toEqual(["router", "logger"]);
		expect(file.creatorName).toBe("creator");
		expect(sm.listSources()[0]?.subscribers).toEqual(["router", "logger"]);
	});

	it("setSource updates an existing source by name instead of creating a duplicate", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource({ name: "s", command: "node", args: ["old.js"], subscribers: ["a"] }, "creator");
		sm.setSource({ name: "s", command: "node", args: ["new.js"], subscribers: ["b", "c"] }, "creator");

		const sources = sm.listSources();
		expect(sources).toHaveLength(1);
		expect(sources[0]).toMatchObject({
			name: "s",
			command: "node",
			args: ["new.js"],
			subscribers: ["b", "c"],
		});
		expect(discoverSourceConfigs(workspace)[0]?.subscribers).toEqual(["b", "c"]);
	});

	it("setSource preserves existing subscribers when subscribers is omitted", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource({ name: "s", command: "node", args: ["old.js"], subscribers: ["a"] }, "creator");
		sm.setSource({ name: "s", command: "node", args: ["new.js"] }, "creator");

		expect(sm.listSources()[0]?.subscribers).toEqual(["a"]);
		expect(discoverSourceConfigs(workspace)[0]?.subscribers).toEqual(["a"]);
	});

	it("setSource writes a source.json with the just-computed subscribers", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource(
			{
				name: "lark-bot",
				command: "node",
				args: ["bridge.js"],
				cwd: undefined,
				env: { LARK_APP_ID: "cli_x" },
			},
			"router",
		);

		const files = discoverSourceConfigs(workspace);
		expect(files).toHaveLength(1);
		const file = files[0]!;
		expect(file.name).toBe("lark-bot");
		expect(file.command).toBe("node");
		expect(file.env).toEqual({ LARK_APP_ID: "cli_x" });
		// Auto-subscribe the creator → subscribers list is non-empty
		expect(file.subscribers).toEqual(["router"]);
		expect(file.creatorName).toBe("router");
	});

	it("setSource / removeAgentSubscriptions rewrite the file", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource({ name: "s", command: "y", args: [], cwd: undefined, env: undefined }, "creator");

		const readFile = (): string[] => discoverSourceConfigs(workspace).flatMap((f) => f.subscribers);

		expect(readFile()).toEqual(["creator"]);

		sm.setSource({
			name: "s",
			command: "y",
			args: [],
			cwd: undefined,
			env: undefined,
			subscribers: ["creator", "other-agent"],
		});
		expect(readFile().sort()).toEqual(["creator", "other-agent"]);

		sm.setSource({ name: "s", command: "y", args: [], cwd: undefined, env: undefined, subscribers: ["creator"] });
		expect(readFile()).toEqual(["creator"]);

		sm.removeAgentSubscriptions("creator");
		expect(readFile()).toEqual([]);
		// File still exists (the source is alive, just nobody is subscribed)
		expect(existsSync(join(workspace, "sources", "s", "source.json"))).toBe(true);
	});

	it("deleteSource removes the source.json from disk", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource({ name: "s", command: "y", args: [], cwd: undefined, env: undefined });
		expect(existsSync(join(workspace, "sources", "s", "source.json"))).toBe(true);

		sm.deleteSource("s");
		expect(existsSync(join(workspace, "sources", "s"))).toBe(false);
	});

	it("deleteSource removes source.json even when subscribers are present", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.setSource({ name: "s", command: "y", subscribers: ["creator"] }, "creator");

		sm.deleteSource("s");

		expect(existsSync(join(workspace, "sources", "s"))).toBe(false);
		expect(sm.listSources()).toEqual([]);
	});

	it("does not write to disk when workspaceRoot is not configured (unit-test mode)", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, {}); // no workspaceRoot
		sm.setSource({ name: "s", command: "y", args: [], cwd: undefined, env: undefined });
		// No file should be created
		expect(existsSync(join(workspace, "sources"))).toBe(false);
	});
});

describe("SourceManager.restoreFromConfigs", () => {
	it("re-spawns a persisted source and re-subscribes live agents", () => {
		const workspace = freshWorkspace();
		// Pre-write a source.json with two subscribers
		writeSourceConfig(workspace, {
			name: "lark-bot",
			command: "node",
			args: ["bridge.js"],
			cwd: undefined,
			env: { LARK_APP_ID: "cli_x" },
			subscribers: ["router", "ghost-agent"],
			creatorName: "router",
		});

		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.restoreFromConfigs(
			[discoverSourceConfigs(workspace)[0]!],
			new Set(["router", "logger"]), // ghost-agent is not alive
		);

		// The source is in the live registry
		expect(sm.listSources().map((s) => s.name)).toEqual(["lark-bot"]);
		// "router" re-subscribed; "ghost-agent" dropped (not in live set)
		expect(sm.getAgentSubscriptions("router")).toEqual(["lark-bot"]);
		expect(sm.getAgentSubscriptions("ghost-agent")).toEqual([]);
		// "logger" was in the live set but NOT a persisted subscriber → still empty
		expect(sm.getAgentSubscriptions("logger")).toEqual([]);
	});

	it("skips sources whose name is already registered (operator re-created at runtime)", () => {
		const workspace = freshWorkspace();
		writeSourceConfig(workspace, {
			name: "x",
			command: "y",
			args: [],
			cwd: undefined,
			env: undefined,
			subscribers: ["a"],
		});

		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		// Operator pre-registered a source with the same name
		sm.setSource({ name: "x", command: "y-runtime", args: [], cwd: undefined, env: undefined });

		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			sm.restoreFromConfigs([discoverSourceConfigs(workspace)[0]!], new Set(["a"]));
			const skipped = stderr.mock.calls.some((call: StderrWriteCall) =>
				String(call[0]).includes('Skipping restore of source "x"'),
			);
			expect(skipped).toBe(true);
			// Runtime-created source wins; persisted subscribers NOT applied
			// (the operator's runtime setSource is authoritative).
			expect(sm.getAgentSubscriptions("a")).toEqual([]);
		} finally {
			stderr.mockRestore();
		}
	});

	it("does nothing when there are no persisted configs", () => {
		const workspace = freshWorkspace();
		const sm = new SourceManager(() => {}, { workspaceRoot: workspace });
		sm.restoreFromConfigs([], new Set());
		expect(sm.listSources()).toEqual([]);
	});
});
