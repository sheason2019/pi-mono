import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutorClient } from "../src/executor/client.ts";

interface FakeHub {
	url: string;
	port: number;
	registeredConnectIds: string[];
	receivedEvents: Array<{ connectId: string; body: unknown }>;
	pushSse: (connectId: string, event: string, data: unknown) => void;
	close: () => Promise<void>;
}

async function startFakeHub(): Promise<FakeHub> {
	const registeredConnectIds: string[] = [];
	const receivedEvents: Array<{ connectId: string; body: unknown }> = [];
	const sseClients = new Map<string, ServerResponse>();

	function readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => resolve(Buffer.concat(chunks).toString()));
			req.on("error", reject);
		});
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "POST" && url.pathname === "/_hub/executor/register") {
			const body = JSON.parse(await readBody(req));
			registeredConnectIds.push(body.connectId);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/_hub/executor/events") {
			const connectId = url.searchParams.get("connectId");
			if (!connectId || !registeredConnectIds.includes(connectId)) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "not registered" }));
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.flushHeaders();
			res.write("event: connected\ndata: " + JSON.stringify({ connectId }) + "\n\n");
			sseClients.set(connectId, res);
			req.on("close", () => sseClients.delete(connectId));
			return;
		}
		if (req.method === "POST" && url.pathname === "/_hub/executor/results") {
			const body = JSON.parse(await readBody(req));
			receivedEvents.push({ connectId: body.connectId, body });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const port = address.port;
	const url = "http://127.0.0.1:" + port;

	return {
		url,
		port,
		registeredConnectIds,
		receivedEvents,
		pushSse: (connectId, event, data) => {
			const client = sseClients.get(connectId);
			if (!client) throw new Error("no sse client for " + connectId);
			client.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sseClients.values()) s.end();
				server.close(() => resolve());
			}),
	};
}

describe("ExecutorClient", () => {
	let hub: FakeHub;
	beforeAll(async () => {
		hub = await startFakeHub();
	});
	afterAll(async () => {
		await hub.close();
	});

	it("registers, receives the connected greeting, dispatches remote-call, sends result", async () => {
		const received: Array<{ callId: string; tool: string; params: unknown }> = [];
		const client = new ExecutorClient({
			hubUrl: hub.url,
			authToken: "tok",
			connectId: "c1",
			onCommand: (event) => {
				received.push(event);
				void client.sendResult({
					callId: event.callId,
					ok: true,
					result: { echo: event.params },
				});
			},
		});
		await client.start();

		for (let i = 0; i < 50; i++) {
			if (hub.registeredConnectIds.includes("c1")) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(hub.registeredConnectIds).toContain("c1");

		hub.pushSse("c1", "remote-call", { callId: "x", tool: "bash", params: { command: "ls" } });

		for (let i = 0; i < 50; i++) {
			if (received.length > 0) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({ callId: "x", tool: "bash", params: { command: "ls" } });

		for (let i = 0; i < 50; i++) {
			if (hub.receivedEvents.length > 0) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(hub.receivedEvents).toHaveLength(1);
		expect(hub.receivedEvents[0].connectId).toBe("c1");
		expect(hub.receivedEvents[0].body).toMatchObject({ callId: "x", ok: true, result: { echo: { command: "ls" } } });

		await client.sendResult({ callId: "y", ok: true, result: 42 });
		for (let i = 0; i < 50; i++) {
			if (hub.receivedEvents.length > 1) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(hub.receivedEvents).toHaveLength(2);
		expect(hub.receivedEvents[1].body).toMatchObject({ callId: "y", result: 42 });

		await client.sendResult({ callId: "z", ok: false, error: "boom" });
		for (let i = 0; i < 50; i++) {
			if (hub.receivedEvents.length > 2) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(hub.receivedEvents).toHaveLength(3);
		expect(hub.receivedEvents[2].body).toMatchObject({ callId: "z", ok: false, error: "boom" });
	});
});
