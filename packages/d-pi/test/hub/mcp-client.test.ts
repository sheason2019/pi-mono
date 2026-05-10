import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpClient, type McpClientHandle, McpClientTimeoutError } from "../../src/hub/mcp/mcp-client.js";
import { startHttpMcpEverythingServer } from "./fixtures/mcp/http-everything-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, "fixtures", "mcp", name);

const tempDirs: string[] = [];

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			parts.push(chunk);
		});
		req.on("end", () => {
			if (parts.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

function isPidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killPid(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// best-effort test cleanup
	}
}

async function startHttpMcpToolsOnlyServerWithInvalidUnsupportedErrors(): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const server: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const body = req.method === "POST" ? await readJsonBody(req) : undefined;
		if (req.method === "GET") {
			res.statusCode = 405;
			res.end();
			return;
		}
		if (req.method !== "POST" || !body || body.jsonrpc !== "2.0") {
			res.statusCode = 400;
			res.end();
			return;
		}
		res.setHeader("content-type", "application/json");
		if (body.method === "initialize") {
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: { tools: { listChanged: true } },
						serverInfo: { name: "tools-only", version: "1.0.0" },
					},
				}),
			);
			return;
		}
		if (body.method === "notifications/initialized") {
			res.statusCode = 202;
			res.end("{}");
			return;
		}
		if (body.method === "tools/list") {
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: { tools: [{ name: "onlyTool", inputSchema: { type: "object", properties: {} } }] },
				}),
			);
			return;
		}
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32601, message: `Method ${String(body.method)} not found` },
			}),
		);
	});

	return await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr == null || typeof addr === "string") {
				reject(new Error("no address"));
				return;
			}
			resolve({
				baseUrl: `http://127.0.0.1:${addr.port}/mcp`,
				close: () =>
					new Promise((resClose, rej) => {
						server.close((err) => {
							if (err) {
								rej(err);
							} else {
								resClose();
							}
						});
					}),
			});
		});
	});
}

describe("createMcpClient", () => {
	const handles: McpClientHandle[] = [];
	const httpCleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const h of handles.splice(0)) {
			await h.close().catch(() => {});
		}
		for (const c of httpCleanups.splice(0)) {
			await c().catch(() => {});
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("connects to a stdio server and surfaces tools, resources, and prompts", async () => {
		const h = await createMcpClient(
			{
				name: "s",
				transport: "stdio",
				command: "node",
				args: [fixture("stdio-everything.mjs")],
			},
			{ timeoutMs: 15_000 },
		);
		handles.push(h);
		expect(h.transport).toBe("stdio");
		const names = (x: { name: string }[]) => x.map((e) => e.name).sort();
		expect(names(h.capabilities.tools)).toEqual(["fixtureTool"]);
		expect(h.capabilities.resources.map((r) => r.uri)).toEqual(["fixture://item"]);
		expect(names(h.capabilities.prompts)).toEqual(["fixturePrompt"]);
		expect(h.supportedCapabilities).toEqual({ tools: true, resources: true, prompts: true });
	});

	it("connects to a streamable HTTP server and surfaces tool, resource, and prompt lists", async () => {
		const { baseUrl, close } = await startHttpMcpEverythingServer();
		httpCleanups.push(close);
		const h = await createMcpClient(
			{
				name: "h",
				transport: "http",
				url: baseUrl,
			},
			{ timeoutMs: 15_000 },
		);
		handles.push(h);
		expect(h.transport).toBe("http");
		const toolNames = h.capabilities.tools.map((t) => t.name).sort();
		expect(toolNames).toEqual(["httpTool"]);
		expect(h.capabilities.resources.map((r) => r.uri).sort()).toEqual(["http://fixture.test/resource"]);
		expect(h.capabilities.prompts.map((p) => p.name).sort()).toEqual(["httpPrompt"]);
		expect(h.supportedCapabilities).toEqual({ tools: true, resources: true, prompts: true });
	});

	it("treats unadvertised resources as an empty list (not an error)", async () => {
		const h = await createMcpClient(
			{
				name: "t1",
				transport: "stdio",
				command: "node",
				args: [fixture("stdio-tools-only.mjs")],
			},
			{ timeoutMs: 15_000 },
		);
		handles.push(h);
		expect(h.capabilities.tools.length).toBe(1);
		expect(h.capabilities.resources).toEqual([]);
		expect(h.supportedCapabilities.tools).toBe(true);
		expect(h.supportedCapabilities.resources).toBe(false);
		expect(h.supportedCapabilities.prompts).toBe(false);
	});

	it("does not call unadvertised HTTP list methods", async () => {
		const { baseUrl, close } = await startHttpMcpToolsOnlyServerWithInvalidUnsupportedErrors();
		httpCleanups.push(close);

		const h = await createMcpClient(
			{
				name: "http-tools-only",
				transport: "http",
				url: baseUrl,
			},
			{ timeoutMs: 15_000 },
		);

		handles.push(h);
		expect(h.capabilities.tools.map((t) => t.name)).toEqual(["onlyTool"]);
		expect(h.capabilities.resources).toEqual([]);
		expect(h.capabilities.prompts).toEqual([]);
		expect(h.supportedCapabilities).toEqual({ tools: true, resources: false, prompts: false });
	});

	it("treats unadvertised tools and resources as empty when only prompts are offered", async () => {
		const h = await createMcpClient(
			{
				name: "prompts-only",
				transport: "stdio",
				command: "node",
				args: [fixture("stdio-prompts-only.mjs")],
			},
			{ timeoutMs: 15_000 },
		);
		handles.push(h);
		expect(h.capabilities.tools).toEqual([]);
		expect(h.capabilities.resources).toEqual([]);
		expect(h.capabilities.prompts.map((p) => p.name).sort()).toEqual(["onlyPrompt"]);
		expect(h.supportedCapabilities.tools).toBe(false);
		expect(h.supportedCapabilities.resources).toBe(false);
		expect(h.supportedCapabilities.prompts).toBe(true);
	});

	it("rejects on stdio connect timeout and terminates the child", async () => {
		await expect(
			createMcpClient(
				{
					name: "hang",
					transport: "stdio",
					command: "node",
					args: [fixture("stdio-hang.mjs")],
				},
				{ timeoutMs: 400 },
			),
		).rejects.toThrow(McpClientTimeoutError);
	});

	it("rejects when the stdio server exits during initialize", async () => {
		await expect(
			createMcpClient(
				{
					name: "x",
					transport: "stdio",
					command: "node",
					args: [fixture("stdio-exit-immediate.mjs")],
				},
				{ timeoutMs: 5000 },
			),
		).rejects.toThrow();
	});

	it("close is idempotent and does not throw when called twice", async () => {
		const h = await createMcpClient(
			{
				name: "c",
				transport: "stdio",
				command: "node",
				args: [fixture("stdio-everything.mjs")],
			},
			{ timeoutMs: 15_000 },
		);
		await h.close();
		await h.close();
	});

	it("stdio close terminates grandchildren spawned by the MCP server", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-child-cleanup-"));
		tempDirs.push(dir);
		const childPidFile = join(dir, "child.pid");
		const h = await createMcpClient(
			{
				name: "spawns-child",
				transport: "stdio",
				command: "node",
				args: [fixture("stdio-spawns-child.mjs")],
				env: { PI_MCP_CHILD_PID_FILE: childPidFile },
			},
			{ timeoutMs: 15_000 },
		);
		const childPid = Number(readFileSync(childPidFile, "utf8"));
		expect(Number.isInteger(childPid)).toBe(true);
		expect(isPidRunning(childPid)).toBe(true);

		try {
			await h.close();

			await vi.waitFor(() => {
				expect(isPidRunning(childPid)).toBe(false);
			});
		} finally {
			if (isPidRunning(childPid)) {
				killPid(childPid);
			}
		}
	});

	it("http: close is idempotent after a client session", async () => {
		const { baseUrl, close } = await startHttpMcpEverythingServer();
		httpCleanups.push(close);
		const h = await createMcpClient({ name: "h2", transport: "http", url: baseUrl }, { timeoutMs: 15_000 });
		await h.close();
		await h.close();
	});

	it("http: a new client can connect to the same server after the previous client was closed", async () => {
		const { baseUrl, close } = await startHttpMcpEverythingServer();
		httpCleanups.push(close);
		const first = await createMcpClient({ name: "h3", transport: "http", url: baseUrl }, { timeoutMs: 15_000 });
		await first.close();
		const second = await createMcpClient({ name: "h3b", transport: "http", url: baseUrl }, { timeoutMs: 15_000 });
		handles.push(second);
		expect(second.capabilities.tools.map((t) => t.name)).toContain("httpTool");
	});
});
