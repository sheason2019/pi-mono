import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceMessageSource } from "../../src/hub/agent/types.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";
import { SourceHost, type SourceHostInboundBridge, type SpawnStdioSource } from "../../src/hub/sources/source-host.js";

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

function rpcMessage(params: { content: string; delivery?: string }): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		method: "queue/write",
		params,
	});
}

describe("source inbound JSON-RPC (Task 5)", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates source messageSource metadata", () => {
		expect(createSourceMessageSource("my-src")).toEqual({ kind: "source", name: "my-src" });
	});

	it("queues source messages without delivery semantics", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-in-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-a", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "hello" })}\n`, "utf8"));
		await vi.waitFor(() => expect(submitFromSource).toHaveBeenCalled());

		expect(submitFromSource).toHaveBeenCalledWith("src-a", MAIN_AGENT_ID, "hello");
		expect(host.getStatuses()[0]?.status).toBe("running");
		expect(host.getStatuses()[0]?.agentId).toBe(MAIN_AGENT_ID);
	});

	it("does not consult run-state delivery defaults for source messages", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-stream-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-b", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "during" })}\n`, "utf8"));
		await vi.waitFor(() => expect(submitFromSource).toHaveBeenCalled());

		expect(submitFromSource).toHaveBeenCalledWith("src-b", MAIN_AGENT_ID, "during");
	});

	it("rejects legacy source delivery params", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-deliv-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-c", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "fu", delivery: "followUp" })}\n`, "utf8"));

		await vi.waitFor(() => expect(host.getStatuses()[0]?.status).toBe("error"));
		expect(host.getStatuses()[0]?.error).toMatch(/delivery/i);
		expect(submitFromSource).not.toHaveBeenCalled();
	});

	it("sets error status and does not submit on malformed JSON line", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-badjson-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-d", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from("not-json\n", "utf8"));
		await vi.waitFor(() => expect(host.getStatuses()[0]?.status).toBe("error"));

		expect(submitFromSource).not.toHaveBeenCalled();
		expect(host.getStatuses()[0]?.error).toMatch(/json/i);
	});

	it("sets error when JSON-RPC line includes id (not a notification)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-notify-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-req", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					jsonrpc: "2.0",
					method: "message",
					params: { content: "x" },
					id: 1,
				})}\n`,
				"utf8",
			),
		);
		await vi.waitFor(() => expect(host.getStatuses()[0]?.status).toBe("error"));
		expect(submitFromSource).not.toHaveBeenCalled();
		expect(host.getStatuses()[0]?.error).toMatch(/notification/i);
	});

	it("sets error on unsupported JSON-RPC method", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-method-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-e", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit(
			"data",
			Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "subscribe", params: {} })}\n`, "utf8"),
		);
		await vi.waitFor(() => expect(host.getStatuses()[0]?.status).toBe("error"));
		expect(submitFromSource).not.toHaveBeenCalled();
	});

	it("sets error on invalid params and does not submit", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-params-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-f", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit(
			"data",
			Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "message", params: { content: 1 } })}\n`, "utf8"),
		);
		await vi.waitFor(() => expect(host.getStatuses()[0]?.status).toBe("error"));
		expect(submitFromSource).not.toHaveBeenCalled();
	});

	it("sets error when submitFromSource rejects", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-cb-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-g", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockRejectedValue(new Error("adapter boom"));
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "x" })}\n`, "utf8"));
		await vi.waitFor(() => expect(host.getStatuses()[0]?.status).toBe("error"));
		expect(host.getStatuses()[0]?.error).toContain("adapter boom");
	});

	it("decodes UTF-8 across stdout chunks and routes a split line correctly", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-utf8-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-utf8", transport: "stdio", command: "echo" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		const line = `${rpcMessage({ content: "你好" })}\n`;
		const full = Buffer.from(line, "utf8");
		const firstByteOfNihao = full.indexOf(0xe4);
		expect(firstByteOfNihao).toBeGreaterThanOrEqual(0);
		proc.stdout!.emit("data", full.subarray(0, firstByteOfNihao + 1));
		proc.stdout!.emit("data", full.subarray(firstByteOfNihao + 1));

		await vi.waitFor(() => expect(submitFromSource).toHaveBeenCalled());
		expect(submitFromSource).toHaveBeenCalledWith("src-utf8", MAIN_AGENT_ID, "你好");
		expect(host.getStatuses()[0]?.status).toBe("running");
	});

	it("inbound for agentId: child-a routes to bridge with that agent and reports status", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-agent-child-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-child", transport: "stdio", command: "echo", agentId: "child-a" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });

		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		expect(host.getStatuses()[0]?.agentId).toBe("child-a");

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "to-child" })}\n`, "utf8"));
		await vi.waitFor(() => expect(submitFromSource).toHaveBeenCalled());

		expect(submitFromSource).toHaveBeenCalledWith("src-child", "child-a", "to-child");
	});

	it("routes source messages to each configured target agent without delivery defaults", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-agent-def-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [
				{ name: "src-main-def", transport: "stdio", command: "echo" },
				{ name: "src-child-def", transport: "stdio", command: "echo", agentId: "child-a" },
			],
		});

		const mainProc = createMockChild();
		const childProc = createMockChild();
		const submitFromSource = vi.fn().mockResolvedValue(undefined);
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		let call = 0;
		const spawn: SpawnStdioSource = () => {
			call++;
			return call === 1 ? mainProc : childProc;
		};
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });
		const startPromise = host.start();
		queueMicrotask(() => {
			mainProc.emit("spawn");
			childProc.emit("spawn");
		});
		await startPromise;

		mainProc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "m1" })}\n`, "utf8"));
		await vi.waitFor(() => expect(submitFromSource).toHaveBeenCalled());
		expect(submitFromSource).toHaveBeenLastCalledWith("src-main-def", MAIN_AGENT_ID, "m1");

		childProc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "c1" })}\n`, "utf8"));
		await vi.waitFor(() => expect(submitFromSource).toHaveBeenCalledTimes(2));
		expect(submitFromSource).toHaveBeenLastCalledWith("src-child-def", "child-a", "c1");
	});

	it("sets error when target agent is missing (e.g. bridge throws unknown agent)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-missing-agent-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-miss", transport: "stdio", command: "echo", agentId: "no-such" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockRejectedValue(new Error('Unknown agent id: "no-such"'));
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });
		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "x" })}\n`, "utf8"));
		await vi.waitFor(() => expect(host.getStatuses().find((s) => s.name === "src-miss")?.status).toBe("error"));
		expect(submitFromSource).toHaveBeenCalledWith("src-miss", "no-such", "x");
		expect(host.getStatuses().find((s) => s.name === "src-miss")?.error).toMatch(/no-such/i);
	});

	it("rejects params.delivery before submitting to a target agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-missing-explicit-deliv-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [{ name: "src-miss-deliv", transport: "stdio", command: "echo", agentId: "no-such" }],
		});

		const proc = createMockChild();
		const submitFromSource = vi.fn().mockRejectedValue(new Error('Unknown agent id: "no-such"'));
		const bridge: SourceHostInboundBridge = {
			submitFromSource,
		};
		const spawn: SpawnStdioSource = () => proc;
		const host = new SourceHost({ cwd, spawnStdio: spawn, inbound: bridge });
		const startPromise = host.start();
		queueMicrotask(() => proc.emit("spawn"));
		await startPromise;

		proc.stdout!.emit("data", Buffer.from(`${rpcMessage({ content: "explicit", delivery: "prompt" })}\n`, "utf8"));
		await vi.waitFor(() => expect(host.getStatuses().find((s) => s.name === "src-miss-deliv")?.status).toBe("error"));
		expect(submitFromSource).not.toHaveBeenCalled();
		expect(host.getStatuses().find((s) => s.name === "src-miss-deliv")?.error).toMatch(/delivery/i);
	});
});
