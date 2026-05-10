import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";
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
	const proc = Object.assign(new EventEmitter(), {
		pid: 42,
		stdout,
		stderr,
		kill: () => true,
		...overrides,
	}) as ChildProcess;
	return proc;
}

describe("SourceHost", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("transitions from starting to running after successful spawn", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-start-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "s1", transport: "stdio", command: "noop" }],
		});

		const proc = createMockChild();
		const spawn: SpawnStdioSource = () => proc;

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		const startPromise = host.start();
		queueMicrotask(() => {
			proc.emit("spawn");
		});
		await startPromise;

		expect(host.getStatuses()).toEqual([
			{
				resourceId: expect.any(String),
				name: "s1",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "running",
			},
		]);
	});

	it("records error status when spawn fails synchronously", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-spawn-err-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "bad", transport: "stdio", command: "/nonexistent-binary" }],
		});

		const spawn: SpawnStdioSource = () => {
			throw new Error("ENOENT");
		};

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		await host.start();

		const statuses = host.getStatuses();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.status).toBe("error");
		expect(statuses[0]?.error).toContain("ENOENT");
	});

	it("sets error when child exits unexpectedly", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-exit-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "die", transport: "stdio", command: "die" }],
		});

		const proc = createMockChild();
		const spawn: SpawnStdioSource = () => proc;

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		const startPromise = host.start();
		queueMicrotask(() => {
			proc.emit("spawn");
		});
		await startPromise;

		proc.emit("exit", 1, null);

		await new Promise((r) => setImmediate(r));

		const st = host.getStatuses()[0];
		expect(st?.status).toBe("error");
		expect(st?.error).toBeDefined();
	});

	it("logs source lifecycle events with source names", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-logs-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "timer", transport: "stdio", command: "timer" }],
		});

		const proc = createMockChild();
		const spawn: SpawnStdioSource = () => proc;
		const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };

		const host = new SourceHost({ cwd, spawnStdio: spawn, logs });
		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;
		proc.emit("exit", 0, null);
		await new Promise((r) => setImmediate(r));

		expect(logs.info).toHaveBeenCalledWith("source started", {
			sourceName: "timer",
			agentId: MAIN_AGENT_ID,
		});
		expect(logs.warning).toHaveBeenCalledWith("source exited", {
			sourceName: "timer",
			code: 0,
			signal: null,
		});
	});

	it("stop marks running sources as stopped and kills children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-stop-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "live", transport: "stdio", command: "sleep" }],
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
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		await host.stop();

		expect(killed).toBe(true);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: expect.any(String),
				name: "live",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "stopped",
			},
		]);
	});

	it("disabled: true source is not spawned and is reported as stopped", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-disabled-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "off", transport: "stdio", command: "noop", disabled: true }],
		});

		let spawnCallCount = 0;
		const spawn: SpawnStdioSource = () => {
			spawnCallCount++;
			return createMockChild();
		};

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		await host.start();

		expect(spawnCallCount).toBe(0);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: expect.any(String),
				name: "off",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "stopped",
			},
		]);
	});

	it("disabled: false source still spawns as enabled", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-disabled-false-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "s1", transport: "stdio", command: "noop", disabled: false }],
		});

		const proc = createMockChild();
		const spawn: SpawnStdioSource = () => proc;

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		const startPromise = host.start();
		queueMicrotask(() => {
			proc.emit("spawn");
		});
		await startPromise;

		expect(host.getStatuses()).toEqual([
			{
				resourceId: expect.any(String),
				name: "s1",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "running",
			},
		]);
	});

	it("mixed enabled and disabled sources", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-mixed-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [
				{ name: "off", transport: "stdio", command: "noop", disabled: true },
				{ name: "on", transport: "stdio", command: "run" },
			],
		});

		const proc = createMockChild();
		let spawnCallCount = 0;
		const spawn: SpawnStdioSource = () => {
			spawnCallCount++;
			return proc;
		};

		const host = new SourceHost({ cwd, spawnStdio: spawn });
		const startPromise = host.start();
		queueMicrotask(() => {
			proc.emit("spawn");
		});
		await startPromise;

		expect(spawnCallCount).toBe(1);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: expect.any(String),
				name: "off",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "stopped",
			},
			{
				resourceId: expect.any(String),
				name: "on",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "running",
			},
		]);
	});

	it("runs same-name source resources as independent instances keyed by resourceId", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-sh-same-name-"));
		tempDirs.push(cwd);
		const mainProc = createMockChild();
		const childProc = createMockChild();
		const spawn: SpawnStdioSource = vi.fn().mockReturnValueOnce(mainProc).mockReturnValueOnce(childProc);
		const host = new SourceHost({
			cwd,
			spawnStdio: spawn,
			loadSources: () => [
				{ resourceId: "main-lark", name: "lark", transport: "stdio", command: "run-main" },
				{
					resourceId: "child-a:lark",
					name: "lark",
					transport: "stdio",
					command: "run-child",
					agentId: "child-a",
				},
			],
		});

		const startPromise = host.start();
		queueMicrotask(() => {
			mainProc.emit("spawn");
			childProc.emit("spawn");
		});
		await startPromise;

		expect(spawn).toHaveBeenCalledTimes(2);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: "main-lark",
				name: "lark",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "running",
			},
			{
				resourceId: "child-a:lark",
				name: "lark",
				transport: "stdio",
				agentId: "child-a",
				origin: "hub",
				status: "running",
			},
		]);
	});
});
