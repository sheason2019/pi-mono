import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			parts.push(c);
		});
		req.on("end", () => {
			if (parts.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

/**
 * In-process HTTP MCP server for tests (Streamable HTTP). Only `import`s from
 * `@modelcontextprotocol/sdk` live under `test/fixtures/mcp/`, not in the test
 * file itself.
 */
export async function startHttpMcpEverythingServer(): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const transports: Record<string, StreamableHTTPServerTransport> = {};

	const server: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const host = "127.0.0.1";
			const u = new URL(req.url ?? "/", `http://${host}/`);
			if (u.pathname !== "/mcp") {
				res.statusCode = 404;
				res.end();
				return;
			}
			const sessionIdHeader = req.headers["mcp-session-id"];
			const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
			const body = req.method === "POST" || req.method === "PUT" ? await readJsonBody(req) : undefined;

			if (sessionId && transports[sessionId]) {
				const t = transports[sessionId]!;
				await t.handleRequest(req, res, body);
				return;
			}
			if (!sessionId && req.method === "POST" && isInitializeRequest(body)) {
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (sid) => {
						transports[sid] = transport;
					},
				});
				transport.onclose = () => {
					const sid = transport.sessionId;
					if (sid && transports[sid]) {
						delete transports[sid];
					}
				};
				const mcp = new McpServer({ name: "http-fixture", version: "1.0.0" });
				mcp.registerTool("httpTool", { description: "http tool" }, async () => ({
					content: [{ type: "text", text: "h" }],
				}));
				mcp.registerResource(
					"httpRes",
					"http://fixture.test/resource",
					{ mimeType: "text/plain", description: "r" },
					async () => ({
						contents: [{ uri: "http://fixture.test/resource", text: "r" }],
					}),
				);
				mcp.registerPrompt("httpPrompt", { description: "p" }, async () => ({
					messages: [{ role: "user", content: { type: "text", text: "p" } }],
				}));
				await mcp.connect(transport);
				await transport.handleRequest(req, res, body);
				return;
			}
			if (!res.headersSent) {
				res.statusCode = 400;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ error: "bad-request" }));
			}
		} catch (e) {
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("content-type", "text/plain");
				res.end("error");
			} else {
				// If headers are already sent, error was likely during streaming
				console.error(e);
			}
		}
	});

	return await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr == null || typeof addr === "string") {
				reject(new Error("no address"));
				return;
			}
			const baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
			resolve({
				baseUrl,
				close: () =>
					new Promise((resClose, rej) => {
						for (const sid of Object.keys(transports)) {
							const t = transports[sid];
							delete transports[sid];
							void t.close();
						}
						server.close((err) => {
							if (err) rej(err);
							else resClose();
						});
					}),
			});
		});
	});
}
