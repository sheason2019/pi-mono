import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type McpClientHandle, McpClientTimeoutError } from "../../src/hub/mcp/mcp-client.js";
import { getMcpConfigPath } from "../../src/hub/mcp/mcp-config.js";
import { McpHost, type McpHostOptions } from "../../src/hub/mcp/mcp-host.js";
import type { McpServerConfig, McpToolSummary } from "../../src/hub/mcp/types.js";

const tempDirs: string[] = [];

function createStubClient(partial: Partial<Client> & { callTool: Client["callTool"] }): Client {
	return partial as Client;
}

function writeMcpFile(cwd: string, body: unknown): void {
	const path = getMcpConfigPath(cwd);
	if (
		body &&
		typeof body === "object" &&
		!Array.isArray(body) &&
		Array.isArray((body as { servers?: unknown }).servers)
	) {
		for (const server of (body as { servers: Array<Record<string, unknown>> }).servers) {
			if (typeof server.name === "string" && typeof server.resourceId !== "string") {
				server.resourceId = server.name;
			}
		}
	}
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function makeToolSummary(name: string): McpToolSummary {
	return { name, description: "d", inputSchema: { type: "object", properties: {} } };
}

function buildFakeHandle(
	transport: McpServerConfig["transport"],
	overrides: {
		close?: () => Promise<void>;
		tools?: McpToolSummary[];
	} = {},
): McpClientHandle {
	const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });
	const toolList = overrides.tools ?? [makeToolSummary("echo")];
	const client = createStubClient({ callTool: callTool as Client["callTool"] });
	const close = overrides.close ?? vi.fn().mockResolvedValue(undefined);
	return {
		client,
		capabilities: {
			tools: toolList,
			resources: [],
			prompts: [],
		},
		supportedCapabilities: { tools: true, resources: false, prompts: false },
		transport,
		close,
	};
}

function optionsWithCwd(
	cwd: string,
	customTools: ToolDefinition[],
	createClient: NonNullable<McpHostOptions["createClient"]>,
	extra: Partial<Pick<McpHostOptions, "timeoutMs">> = {},
): McpHostOptions {
	return { cwd, customTools, createClient, timeoutMs: extra.timeoutMs ?? 10_000 };
}

describe("McpHost lifecycle", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("start() with a single working stdio server populates mcp__ tools and reports running", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-stdio-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "a", transport: "stdio", command: "npx" }] });
		const customTools: ToolDefinition[] = [];
		const h = buildFakeHandle("stdio");
		const createClient: McpHostOptions["createClient"] = vi.fn().mockImplementation(async (cfg) => {
			expect(cfg.name).toBe("a");
			return h;
		});
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		const mcp = customTools.filter((t) => t.name.startsWith("mcp__"));
		expect(mcp.length).toBeGreaterThan(0);
		expect(mcp.some((t) => t.name.startsWith("mcp__a__"))).toBe(true);
		expect(host.getStatuses()).toEqual([
			{
				resourceId: "a",
				name: "a",
				transport: "stdio",
				status: "running",
				capabilities: { tools: h.capabilities.tools, resources: [], prompts: [] },
			},
		]);
	});

	it("start() with a single http server reports running", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-http-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "h1", transport: "http", url: "https://ex.example/mcp" }] });
		const customTools: ToolDefinition[] = [];
		const h = buildFakeHandle("http");
		const createClient: McpHostOptions["createClient"] = vi.fn().mockResolvedValue(h);
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		expect(host.getStatuses()[0]).toMatchObject({ name: "h1", transport: "http", status: "running" });
		expect(createClient).toHaveBeenCalledTimes(1);
	});

	it("uses per-server timeoutMs when starting a configured server", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-server-timeout-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "slow", transport: "stdio", command: "x", timeoutMs: 60_000 }] });
		const customTools: ToolDefinition[] = [];
		const h = buildFakeHandle("stdio");
		const createClient: McpHostOptions["createClient"] = vi.fn().mockResolvedValue(h);
		const host = new McpHost({ cwd, customTools, createClient, timeoutMs: 10_000 });

		await host.start();

		expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ name: "slow" }), { timeoutMs: 60_000 });
		expect(host.getStatuses()[0]?.status).toBe("running");
	});

	it("start() with a failed server records error, omits that server's tools, sibling still comes up", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-err-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [
				{ name: "ok", transport: "stdio", command: "a" },
				{ name: "bad", transport: "stdio", command: "b" },
			],
		});
		const customTools: ToolDefinition[] = [];
		const hOk = buildFakeHandle("stdio", { tools: [makeToolSummary("t")] });
		const createClient: McpHostOptions["createClient"] = vi.fn().mockImplementation(async (cfg) => {
			if (cfg.name === "bad") {
				throw new Error("connection refused (fake)");
			}
			return hOk;
		});
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		const bad = host.getStatuses().find((s) => s.name === "bad");
		expect(bad?.status).toBe("error");
		expect(bad?.error).toContain("connection refused");
		expect(customTools.some((t) => t.name.startsWith("mcp__bad__"))).toBe(false);
		expect(customTools.some((t) => t.name.startsWith("mcp__ok__"))).toBe(true);
	});

	it("start() surfaces fast-rejecting timeout-style error from createClient and completes promptly", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-tmo-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "slow", transport: "stdio", command: "x" }] });
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi.fn().mockImplementation(
			(_c, _o) =>
				new Promise<never>((_res, rej) => {
					setTimeout(() => {
						rej(new McpClientTimeoutError("mcp request timeout (fake)"));
					}, 60);
				}),
		);
		const t0 = Date.now();
		const host = new McpHost({ cwd, customTools, createClient, timeoutMs: 50 });
		await host.start();
		const elapsed = Date.now() - t0;
		expect(elapsed).toBeLessThan(500);
		const st = host.getStatuses()[0];
		expect(st?.status).toBe("error");
		expect(String(st?.error).toLowerCase()).toMatch(/timeout/);
		expect(customTools.filter((t) => t.name.startsWith("mcp__"))).toHaveLength(0);
	});

	it("start() with disabled: true does not call createClient and status is stopped", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-off-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "off", transport: "stdio", command: "z", disabled: true }] });
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi.fn();
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		expect(createClient).not.toHaveBeenCalled();
		expect(host.getStatuses()).toEqual([
			{
				resourceId: "off",
				name: "off",
				transport: "stdio",
				status: "stopped",
				disabled: true,
				capabilities: { tools: [], resources: [], prompts: [] },
			},
		]);
	});

	it("mixed startup: ok, error, disabled yields tools only from the ok server", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-mix-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [
				{ name: "a", transport: "stdio", command: "1" },
				{ name: "b", transport: "stdio", command: "2" },
				{ name: "c", transport: "stdio", command: "3", disabled: true },
			],
		});
		const customTools: ToolDefinition[] = [];
		const hA = buildFakeHandle("stdio", { tools: [makeToolSummary("t")] });
		const createClient: McpHostOptions["createClient"] = vi.fn().mockImplementation(async (cfg) => {
			if (cfg.name === "a") {
				return hA;
			}
			if (cfg.name === "b") {
				throw new Error("e2");
			}
			throw new Error("unreachable");
		});
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		const onlyMcp = customTools.filter((t) => t.name.startsWith("mcp__"));
		const prefixes = new Set(onlyMcp.map((t) => t.name.split("__")[1] ?? ""));
		expect(prefixes.size).toBe(1);
		expect(prefixes.has("a")).toBe(true);
		expect(onlyMcp.length).toBeGreaterThan(0);
		const statuses = host.getStatuses();
		expect(statuses.find((s) => s.name === "a")?.status).toBe("running");
		expect(statuses.find((s) => s.name === "b")?.status).toBe("error");
		expect(statuses.find((s) => s.name === "c")?.status).toBe("stopped");
		expect(statuses.find((s) => s.name === "c")?.disabled).toBe(true);
		expect(statuses.find((s) => s.name === "a")?.disabled).toBeFalsy();
		expect(statuses.find((s) => s.name === "b")?.disabled).toBeFalsy();
	});

	it("non-MCP customTools entries survive start, stop, and a second start (same array instance)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-keep-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "s", transport: "stdio", command: "c" }] });
		const t1 = defineTool({
			name: "peer_foo",
			label: "a",
			description: "d",
			parameters: {},
			execute: async () => ({ content: [], details: null }),
		});
		const t2 = defineTool({
			name: "hub_bar",
			label: "b",
			description: "d",
			parameters: {},
			execute: async () => ({ content: [], details: null }),
		});
		const customTools: ToolDefinition[] = [t1, t2];
		const h = buildFakeHandle("stdio");
		const createClient: McpHostOptions["createClient"] = vi.fn().mockResolvedValue(h);
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		expect(customTools[0]).toBe(t1);
		expect(customTools[1]).toBe(t2);
		await host.stop();
		expect(customTools.includes(t1)).toBe(true);
		expect(customTools.includes(t2)).toBe(true);
		await host.start();
		expect(customTools[0]).toBe(t1);
		expect(customTools[1]).toBe(t2);
	});

	it("stop() closes every connected client handle", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-close-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [
				{ name: "x", transport: "stdio", command: "c" },
				{ name: "y", transport: "http", url: "https://e/e" },
			],
		});
		const customTools: ToolDefinition[] = [];
		const c1 = vi.fn().mockResolvedValue(undefined);
		const c2 = vi.fn().mockResolvedValue(undefined);
		const h1 = buildFakeHandle("stdio", { close: c1 });
		const h2 = buildFakeHandle("http", { close: c2 });
		const createClient: McpHostOptions["createClient"] = vi
			.fn()
			.mockImplementation(async (cfg) => (cfg.name === "x" ? h1 : h2));
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		await host.stop();
		expect(c1).toHaveBeenCalledTimes(1);
		expect(c2).toHaveBeenCalledTimes(1);
	});

	it("restart() serializes concurrent invocations: no interleaved connect cycles", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-rst-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "one", transport: "stdio", command: "c" }] });
		const customTools: ToolDefinition[] = [];
		const log: string[] = [];
		const h = buildFakeHandle("stdio", {
			close: vi.fn().mockImplementation(async () => {
				log.push("close");
			}),
		});
		const createClient: McpHostOptions["createClient"] = vi.fn().mockImplementation(async () => {
			log.push("connect");
			return h;
		});
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		expect(log).toEqual(["connect"]);
		log.length = 0;
		const a = host.restart();
		const b = host.restart();
		const c = host.restart();
		await Promise.all([a, b, c]);
		const connects = log.filter((x) => x === "connect").length;
		const closes = log.filter((x) => x === "close").length;
		expect(connects).toBe(1);
		expect(closes).toBe(1);
		for (let i = 0; i < log.length; i++) {
			if (log[i] === "connect" && i > 0) {
				expect(log[i - 1]).toBe("close");
			}
		}
		expect(log).toEqual(["close", "connect"]);
	});

	it("getStatuses() returns entries in mcp.json order", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-ord-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [
				{ name: "z", transport: "stdio", command: "z" },
				{ name: "y", transport: "http", url: "https://y/y" },
				{ name: "q", transport: "stdio", command: "q" },
			],
		});
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi
			.fn()
			.mockImplementation(async (cfg) => buildFakeHandle(cfg.transport));
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		const names = host.getStatuses().map((s) => s.name);
		expect(names).toEqual(["z", "y", "q"]);
	});

	it("malformed mcp.json: start() resolves, getConfigError is set, statuses empty, mcp__ tools cleared", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-lc-bad-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(getMcpConfigPath(cwd), "{\n  not json\n", "utf8");
		const tOther = defineTool({
			name: "x_y",
			label: "x",
			description: "d",
			parameters: {},
			execute: async () => ({ content: [], details: null }),
		});
		const tMcp = defineTool({
			name: "mcp__old__g",
			label: "g",
			description: "d",
			parameters: {},
			execute: async () => ({ content: [], details: null }),
		});
		const customTools: ToolDefinition[] = [tOther, tMcp];
		const createClient: McpHostOptions["createClient"] = vi.fn();
		const host = new McpHost(optionsWithCwd(cwd, customTools, createClient));
		await host.start();
		expect(host.getConfigError()).toBeDefined();
		expect(String(host.getConfigError())).toMatch(/parse|json/i);
		expect(host.getStatuses()).toEqual([]);
		expect(createClient).not.toHaveBeenCalled();
		expect(customTools.includes(tOther)).toBe(true);
		expect(customTools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
	});
});
