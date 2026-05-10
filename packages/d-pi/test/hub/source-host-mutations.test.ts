import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { markDetachedChildProcess } from "../../src/hub/processes/child-process-tree.js";
import {
	getSourcesConfigPath,
	loadSourcesConfig,
	loadSourcesConfigForAgents,
} from "../../src/hub/sources/source-config.js";
import { SourceHost, type SpawnStdioSource } from "../../src/hub/sources/source-host.js";

const tempDirs: string[] = [];

function writeSourcesFile(cwd: string, body: unknown): void {
	const piDir = join(cwd, ".pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(getSourcesConfigPath(cwd), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function createMockChild(
	overrides: Partial<ChildProcess> & { stdout?: EventEmitter; stderr?: EventEmitter } = {},
): ChildProcess {
	const stdout = overrides.stdout ?? new EventEmitter();
	const stderr = overrides.stderr ?? new EventEmitter();
	return Object.assign(new EventEmitter(), {
		pid: 42,
		stdout,
		stderr,
		kill: () => true,
		...overrides,
	}) as ChildProcess;
}

describe("SourceHost mutations", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pauseSource kills running child and reports stopped, persists disabled", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sh-mut-pause-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ resourceId: "src-n1", name: "n1", transport: "stdio", command: "noop" }],
		});

		const proc = createMockChild();
		let killed = false;
		proc.kill = () => {
			killed = true;
			return true;
		};
		const spawn: SpawnStdioSource = () => proc;

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		const startPromise = host.start();
		queueMicrotask(() => {
			proc.emit("spawn");
		});
		await startPromise;

		await host.pauseSource("src-n1");

		expect(killed).toBe(true);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: "src-n1",
				name: "n1",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "stopped",
			},
		]);
		const cfg = loadSourcesConfig(cwd);
		expect(cfg[0]?.disabled).toBe(true);
	});

	it("stop terminates the detached source process group", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sh-mut-stop-group-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ resourceId: "src-n1", name: "n1", transport: "stdio", command: "noop" }],
		});

		const proc = markDetachedChildProcess(
			createMockChild({
				exitCode: null,
				pid: 1234,
				signalCode: null,
			}),
		);
		const childKill = vi.spyOn(proc, "kill");
		const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const host = new SourceHost({ cwd, spawnStdio: () => proc });
			await host.start();

			await host.stop();

			expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");
			expect(childKill).not.toHaveBeenCalled();
		} finally {
			processKill.mockRestore();
			childKill.mockRestore();
		}
	});

	it("pauseSource stops every hub runtime source that shares the selected raw resourceId", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sh-mut-pause-shared-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ resourceId: "shared-source", name: "shared", transport: "stdio", command: "noop" }],
		});
		mkdirSync(join(cwd, ".child-agent", "child-a"), { recursive: true });
		writeFileSync(
			join(cwd, ".child-agent", "child-a", "sources.json"),
			`${JSON.stringify({ extends: { host: { sources: true } }, sources: [] }, null, 2)}\n`,
			"utf8",
		);

		const procs: ChildProcess[] = [];
		const killed = new Set<ChildProcess>();
		const spawn: SpawnStdioSource = () => {
			const proc = createMockChild();
			proc.kill = () => {
				killed.add(proc);
				return true;
			};
			procs.push(proc);
			return proc;
		};

		const host = new SourceHost({
			cwd,
			spawnStdio: spawn,
			loadSources: () => loadSourcesConfigForAgents(cwd, ["child-a"]),
		});
		await host.start();
		for (const proc of procs) {
			proc.emit("spawn");
		}
		expect(
			host
				.getStatuses()
				.map((status) => status.resourceId)
				.sort(),
		).toEqual(["child-a:shared-source", "shared-source"]);

		await host.pauseSource("child-a:shared-source");

		expect(killed.size).toBe(2);
		expect(
			host
				.getStatuses()
				.map((status) => `${status.resourceId}:${status.status}`)
				.sort(),
		).toEqual(["child-a:shared-source:stopped", "shared-source:stopped"]);
		const cfg = loadSourcesConfig(cwd);
		expect(cfg[0]?.disabled).toBe(true);
	});

	it("restartSource clears disabled, kills old child, spawns new child", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sh-mut-restart-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ resourceId: "src-n1", name: "n1", transport: "stdio", command: "noop", disabled: true }],
		});

		let spawnCallCount = 0;
		const newProc = createMockChild();
		const spawn: SpawnStdioSource = () => {
			spawnCallCount++;
			return newProc;
		};

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		await host.start();
		expect(host.getStatuses()[0]?.status).toBe("stopped");
		expect(spawnCallCount).toBe(0);

		const restartP = host.restartSource("src-n1");
		queueMicrotask(() => {
			newProc.emit("spawn");
		});
		await restartP;

		expect(spawnCallCount).toBe(1);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: "src-n1",
				name: "n1",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "running",
			},
		]);
		const raw = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as {
			sources: { name: string; disabled?: boolean }[];
		};
		const entry = raw.sources[0];
		expect(Object.hasOwn(entry, "disabled")).toBe(false);
	});

	it("removeSource deletes from config and from getStatuses, kills child", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sh-mut-rm-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ resourceId: "src-n1", name: "n1", transport: "stdio", command: "noop" }],
		});

		const proc = createMockChild();
		let killed = false;
		proc.kill = () => {
			killed = true;
			return true;
		};
		const spawn: SpawnStdioSource = () => proc;

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		const startPromise = host.start();
		queueMicrotask(() => {
			proc.emit("spawn");
		});
		await startPromise;

		await host.removeSource("src-n1");

		expect(killed).toBe(true);
		expect(host.getStatuses()).toEqual([]);
		expect(loadSourcesConfig(cwd)).toEqual([]);
	});

	it("Each method throws when name does not exist", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sh-mut-miss-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ resourceId: "src-n1", name: "n1", transport: "stdio", command: "noop" }],
		});

		const host = new SourceHost({ cwd, spawnStdio: () => createMockChild() });
		await host.start();

		const re = /not found|unknown/i;
		await expect(host.pauseSource("absent")).rejects.toThrow(re);
		await expect(host.restartSource("absent")).rejects.toThrow(re);
		await expect(host.removeSource("absent")).rejects.toThrow(re);
	});
});
