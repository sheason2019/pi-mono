import { describe, expect, it } from "vitest";
import type { DPiJsonValue, DPiServiceEvent, DPiServiceSnapshot } from "../src/service/protocol.ts";
import { DPiRemoteClient, DPiRemoteClientError } from "../src/tui/remote-client.ts";

interface FetchCall {
	url: string;
	init?: RequestInit;
	body?: DPiJsonValue;
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

class FakeFetch {
	readonly calls: FetchCall[] = [];
	private handler: FetchHandler;

	constructor(handler: FetchHandler) {
		this.handler = handler;
	}

	fetch: typeof fetch = async (input, init) => {
		const url = String(input);
		this.calls.push({ url, init, body: parseRequestBody(init?.body) });
		return this.handler(url, init);
	};
}

class SseStream {
	private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	readonly body = new ReadableStream<Uint8Array>({
		start: (controller) => {
			this.controller = controller;
		},
	});

	push(eventName: string, event: DPiServiceEvent): void {
		this.controller?.enqueue(new TextEncoder().encode(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`));
	}

	pushRaw(text: string): void {
		this.controller?.enqueue(new TextEncoder().encode(text));
	}

	error(error: Error): void {
		this.controller?.error(error);
	}

	close(): void {
		this.controller?.close();
	}
}

function parseRequestBody(body: unknown): DPiJsonValue | undefined {
	if (typeof body !== "string") {
		return undefined;
	}
	return JSON.parse(body) as DPiJsonValue;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function snapshot(agentName: string, status: string): DPiServiceSnapshot {
	return {
		agentName,
		state: { status },
	};
}

describe("DPi remote TUI client", () => {
	it("connect fetches the initial snapshot and stores it", async () => {
		const initial = snapshot("root", "ready");
		const fake = new FakeFetch((url) => {
			if (url === "https://dp.example/api/agents/root/snapshot") {
				return jsonResponse(initial);
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});

		await client.connect();

		expect(client.getSnapshot()).toEqual(initial);
		expect(fake.calls.map((call) => call.url)).toEqual(["https://dp.example/api/agents/root/snapshot"]);
	});

	// Parity marker: streaming-tools:runtime-worker-event-feed
	it("SSE snapshot replaces snapshot while worker events append and notify listeners", async () => {
		const initial = snapshot("root", "ready");
		const replacement = snapshot("root", "streaming");
		const sse = new SseStream();
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/snapshot")) {
				return jsonResponse(initial);
			}
			if (url.endsWith("/events")) {
				return new Response(sse.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});
		const observed: DPiServiceEvent[] = [];
		const unsubscribe = client.onEvent((event) => observed.push(event));

		await client.connect({ subscribe: true });
		sse.push("snapshot", { type: "snapshot", snapshot: replacement });
		sse.push("worker", { type: "worker", event: "token", data: { text: "hi" } });
		await waitFor(() => observed.length === 2);

		expect(client.getSnapshot()).toEqual(replacement);
		expect(client.getEvents()).toEqual([{ type: "worker", event: "token", data: { text: "hi" } }]);
		expect(observed).toEqual([
			{ type: "snapshot", snapshot: replacement },
			{ type: "worker", event: "token", data: { text: "hi" } },
		]);

		unsubscribe();
		client.disconnect();
		sse.close();
	});

	it("keeps SSE pumping when one event listener throws and records the listener error", async () => {
		const initial = snapshot("root", "ready");
		const sse = new SseStream();
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/snapshot")) {
				return jsonResponse(initial);
			}
			if (url.endsWith("/events")) {
				return new Response(sse.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});
		const listenerError = new Error("listener failed");
		const observed: DPiServiceEvent[] = [];
		client.onEvent(() => {
			throw listenerError;
		});
		client.onEvent((event) => observed.push(event));

		await client.connect({ subscribe: true });
		sse.push("worker", { type: "worker", event: "token", data: { text: "first" } });
		sse.push("worker", { type: "worker", event: "token", data: { text: "second" } });
		await waitFor(() => observed.length === 2);

		expect(observed).toEqual([
			{ type: "worker", event: "token", data: { text: "first" } },
			{ type: "worker", event: "token", data: { text: "second" } },
		]);
		expect(client.getErrors()).toEqual([listenerError, listenerError]);

		client.disconnect();
		sse.close();
	});

	it("parses CRLF and CR SSE event boundaries, multiline data, and comment heartbeats", async () => {
		const initial = snapshot("root", "ready");
		const sse = new SseStream();
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/snapshot")) {
				return jsonResponse(initial);
			}
			if (url.endsWith("/events")) {
				return new Response(sse.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});
		const observed: DPiServiceEvent[] = [];
		client.onEvent((event) => observed.push(event));

		await client.connect({ subscribe: true });
		sse.pushRaw(": heartbeat\r\n\r\n");
		sse.pushRaw('data: {"type":"worker",\r\ndata: "event":"token",\r\ndata: "data":{"text":"crlf"}}\r\n\r\n');
		sse.pushRaw('data: {"type":"worker","event":"token","data":{"text":"cr"}}\r\r');
		await waitFor(() => observed.length === 2);

		expect(observed).toEqual([
			{ type: "worker", event: "token", data: { text: "crlf" } },
			{ type: "worker", event: "token", data: { text: "cr" } },
		]);

		client.disconnect();
		sse.close();
	});

	it("records malformed SSE JSON without dropping later valid events", async () => {
		const initial = snapshot("root", "ready");
		const sse = new SseStream();
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/snapshot")) {
				return jsonResponse(initial);
			}
			if (url.endsWith("/events")) {
				return new Response(sse.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});
		const observed: DPiServiceEvent[] = [];
		client.onEvent((event) => observed.push(event));

		await client.connect({ subscribe: true });
		sse.pushRaw("data: not-json\n\n");
		sse.push("worker", { type: "worker", event: "token", data: { text: "after-invalid" } });
		await waitFor(() => observed.length === 1 && client.getErrors().length === 1);

		expect(observed).toEqual([{ type: "worker", event: "token", data: { text: "after-invalid" } }]);
		expect(client.getErrors()[0]).toBeInstanceOf(SyntaxError);

		client.disconnect();
		sse.close();
	});

	it("records SSE reader failures from the background pump", async () => {
		const initial = snapshot("root", "ready");
		const sse = new SseStream();
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/snapshot")) {
				return jsonResponse(initial);
			}
			if (url.endsWith("/events")) {
				return new Response(sse.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});
		const readerError = new Error("reader failed");

		await client.connect({ subscribe: true });
		sse.error(readerError);
		await waitFor(() => client.getErrors().length === 1);

		expect(client.getErrors()).toEqual([readerError]);

		client.disconnect();
	});

	it("does not keep a failed subscription active when setAgentName decides whether to resubscribe", async () => {
		const snapshots: Record<string, DPiServiceSnapshot> = {
			root: snapshot("root", "ready"),
			helper: snapshot("helper", "ready"),
		};
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/events")) {
				return jsonResponse({ error: { code: "unavailable", message: "events unavailable" } }, 503);
			}
			const match = url.match(/\/api\/agents\/([^/]+)\/snapshot$/);
			if (match) {
				return jsonResponse(snapshots[decodeURIComponent(match[1] ?? "")] ?? snapshot("missing", "missing"));
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});

		await expect(client.connect({ subscribe: true })).rejects.toMatchObject({
			code: "unavailable",
			status: 503,
		});
		await client.setAgentName("helper");

		expect(client.getSnapshot()).toEqual(snapshots.helper);
		expect(fake.calls.map((call) => call.url)).toEqual([
			"https://dp.example/api/agents/root/snapshot",
			"https://dp.example/api/agents/root/events",
			"https://dp.example/api/agents/helper/snapshot",
		]);
	});

	it("POSTs prompt, steer, and followUp actions to service paths with auth headers", async () => {
		const fake = new FakeFetch(() => jsonResponse({ ok: true }));
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example/",
			agentName: "root",
			authHeaders: { Authorization: "Bearer token" },
			fetch: fake.fetch,
		});

		await client.prompt("hello", { images: [{ url: "file:///tmp/a.png" }] });
		await client.steer("adjust");
		await client.followUp("continue");

		expect(fake.calls.map((call) => call.url)).toEqual([
			"https://dp.example/api/agents/root/actions/prompt",
			"https://dp.example/api/agents/root/actions/steer",
			"https://dp.example/api/agents/root/actions/follow-up",
		]);
		expect(fake.calls.map((call) => call.init?.method)).toEqual(["POST", "POST", "POST"]);
		expect(fake.calls.map((call) => call.init?.headers)).toEqual([
			{ Authorization: "Bearer token", "Content-Type": "application/json" },
			{ Authorization: "Bearer token", "Content-Type": "application/json" },
			{ Authorization: "Bearer token", "Content-Type": "application/json" },
		]);
		expect(fake.calls.map((call) => call.body)).toEqual([
			{ text: "hello", options: { images: [{ url: "file:///tmp/a.png" }] } },
			{ text: "adjust" },
			{ text: "continue" },
		]);
	});

	it("turns stable service error envelopes into client errors with code and status", async () => {
		const fake = new FakeFetch(() => jsonResponse({ error: { code: "not_found", message: "Agent not found" } }, 404));
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "missing",
			fetch: fake.fetch,
		});

		await expect(client.connect()).rejects.toMatchObject({
			name: "DPiRemoteClientError",
			code: "not_found",
			message: "Agent not found",
			status: 404,
		});
		await expect(client.connect()).rejects.toBeInstanceOf(DPiRemoteClientError);
	});

	// Parity marker: remote-recovery:snapshot-recovery-after-agent-switch
	it("setAgentName reconnects through snapshot recovery and resets transient events", async () => {
		const snapshots: Record<string, DPiServiceSnapshot> = {
			root: snapshot("root", "ready"),
			helper: snapshot("helper", "ready"),
		};
		const streams: SseStream[] = [];
		const fake = new FakeFetch((url) => {
			if (url.endsWith("/events")) {
				const stream = new SseStream();
				streams.push(stream);
				return new Response(stream.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			}
			const match = url.match(/\/api\/agents\/([^/]+)\/snapshot$/);
			if (match) {
				return jsonResponse(snapshots[decodeURIComponent(match[1] ?? "")] ?? snapshot("missing", "missing"));
			}
			return jsonResponse({ error: { code: "unexpected", message: url } }, 500);
		});
		const client = new DPiRemoteClient({
			baseUrl: "https://dp.example",
			agentName: "root",
			fetch: fake.fetch,
		});

		await client.connect({ subscribe: true });
		streams[0]?.push("worker", { type: "worker", event: "token", data: { text: "before-switch" } });
		await waitFor(() => client.getEvents().length === 1);
		await client.setAgentName("helper");

		expect(client.getSnapshot()).toEqual(snapshots.helper);
		expect(client.getEvents()).toEqual([]);
		expect(fake.calls.map((call) => call.url)).toContain("https://dp.example/api/agents/helper/snapshot");
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > 500) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
