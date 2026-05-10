import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpClientHandle } from "../../src/hub/mcp/mcp-client.js";
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

function buildFakeHandle(transport: McpServerConfig["transport"]): McpClientHandle {
	const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });
	return {
		client: createStubClient({ callTool: callTool as Client["callTool"] }),
		capabilities: {
			tools: [makeToolSummary("t")],
			resources: [],
			prompts: [],
		},
		supportedCapabilities: { tools: true, resources: false, prompts: false },
		transport,
		close: vi.fn().mockResolvedValue(undefined),
	};
}

function hostOpts(
	cwd: string,
	customTools: ToolDefinition[],
	createClient: NonNullable<McpHostOptions["createClient"]>,
): McpHostOptions {
	return { cwd, customTools, createClient };
}

describe("McpHost mutators", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pauseServer writes disabled: true to mcp.json and status becomes stopped; sibling unchanged", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-mut-pause-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [
				{ name: "foo", transport: "stdio", command: "a" },
				{ name: "bar", transport: "stdio", command: "b" },
			],
		});
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi
			.fn()
			.mockImplementation(async (cfg) => buildFakeHandle(cfg.transport));
		const host = new McpHost(hostOpts(cwd, customTools, createClient));
		await host.start();
		const beforeBar = host.getStatuses().find((s) => s.name === "bar");
		expect(beforeBar?.status).toBe("running");

		const r = await host.pauseServer("foo");
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		const raw = readFileSync(getMcpConfigPath(cwd), "utf8");
		const parsed = JSON.parse(raw) as { servers: Array<{ name: string; disabled?: boolean }> };
		const foo = parsed.servers.find((s) => s.name === "foo");
		expect(foo?.disabled).toBe(true);

		const after = r.servers;
		expect(after.find((s) => s.name === "foo")?.status).toBe("stopped");
		expect(after.find((s) => s.name === "foo")?.disabled).toBe(true);
		expect(after.find((s) => s.name === "bar")?.status).toBe("running");
		expect(after.find((s) => s.name === "bar")?.disabled).toBeFalsy();
	});

	it("restartServer clears disabled in mcp.json and server reaches running", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-mut-resume-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [{ name: "foo", transport: "stdio", command: "a", disabled: true }],
		});
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi
			.fn()
			.mockImplementation(async (cfg) => buildFakeHandle(cfg.transport));
		const host = new McpHost(hostOpts(cwd, customTools, createClient));
		await host.start();
		expect(host.getStatuses()[0]?.status).toBe("stopped");
		expect(host.getStatuses()[0]?.disabled).toBe(true);
		expect(createClient).toHaveBeenCalledTimes(0);

		const r = await host.restartServer("foo");
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		const raw = readFileSync(getMcpConfigPath(cwd), "utf8");
		const parsed = JSON.parse(raw) as { servers: Array<Record<string, unknown>> };
		expect(parsed.servers[0]?.disabled).toBeUndefined();
		expect(r.servers[0]?.status).toBe("running");
		expect(r.servers[0]?.disabled).toBeFalsy();
		expect(vi.mocked(createClient).mock.calls.length).toBeGreaterThan(0);
	});

	it("removeServer deletes the entry and getStatuses() omits the name", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-mut-remove-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, {
			servers: [
				{ name: "foo", transport: "stdio", command: "a" },
				{ name: "bar", transport: "http", url: "https://u/u" },
			],
		});
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi
			.fn()
			.mockImplementation(async (cfg) => buildFakeHandle(cfg.transport));
		const host = new McpHost(hostOpts(cwd, customTools, createClient));
		await host.start();
		const r = await host.removeServer("foo");
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		const raw = readFileSync(getMcpConfigPath(cwd), "utf8");
		const parsed = JSON.parse(raw) as { servers: Array<{ name: string }> };
		expect(parsed.servers.map((s) => s.name)).toEqual(["bar"]);
		expect(r.servers.map((s) => s.name)).toEqual(["bar"]);
	});

	it("unknown server name: ok false, error matches /unknown/i, mcp.json unchanged (byte-identical)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-mut-unk-"));
		tempDirs.push(cwd);
		writeMcpFile(cwd, { servers: [{ name: "foo", transport: "stdio", command: "a" }] });
		const before = readFileSync(getMcpConfigPath(cwd));
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi
			.fn()
			.mockImplementation(async (cfg) => buildFakeHandle(cfg.transport));
		const host = new McpHost(hostOpts(cwd, customTools, createClient));
		await host.start();

		const pa = await host.pauseServer("nope");
		const rb = await host.restartServer("nope");
		const rc = await host.removeServer("nope");
		for (const r of [pa, rb, rc]) {
			expect(r.ok).toBe(false);
			if (r.ok) {
				return;
			}
			expect(r.error).toMatch(/unknown/i);
		}
		const after = readFileSync(getMcpConfigPath(cwd));
		expect(after.equals(before)).toBe(true);
	});

	it("mutator on malformed mcp.json returns file parse error, not unknown-server", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-mut-bad-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(getMcpConfigPath(cwd), "{\n  broken", "utf8");
		const customTools: ToolDefinition[] = [];
		const createClient: McpHostOptions["createClient"] = vi.fn();
		const host = new McpHost(hostOpts(cwd, customTools, createClient));
		const r = await host.pauseServer("foo");
		expect(r.ok).toBe(false);
		if (r.ok) {
			return;
		}
		expect(r.error).toMatch(/parse|json/i);
		expect(r.error.toLowerCase()).not.toContain("unknown mcp");
	});
});
