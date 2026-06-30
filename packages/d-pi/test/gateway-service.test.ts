import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import type { HubToWorkerMessage, WorkerToHubMessage } from "../src/types.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

interface FakeWorker {
	posted: HubToWorkerMessage[];
	postMessage(message: HubToWorkerMessage): void;
	on(event: string, handler: (message: WorkerToHubMessage) => void): void;
	off(event: string, handler: (message: WorkerToHubMessage) => void): void;
	emit(message: WorkerToHubMessage): void;
	listenerCount(event: string): number;
}

type FakeWorkerHttpMessage = Extract<HubToWorkerMessage, { type: "http_query" | "http_request" }>;

interface FakeWorkerOptions {
	readonly autoRespond?: boolean;
	readonly respond?: (message: FakeWorkerHttpMessage) => { status: number; body: unknown };
}

function createFakeWorker(agentName: string, state: unknown, options: FakeWorkerOptions = {}): FakeWorker {
	const listeners = new Set<(message: WorkerToHubMessage) => void>();
	const posted: HubToWorkerMessage[] = [];
	const emit = (message: WorkerToHubMessage) => {
		for (const listener of listeners) {
			listener(message);
		}
	};
	return {
		posted,
		postMessage(message) {
			posted.push(message);
			if (message.type !== "http_query" && message.type !== "http_request") {
				return;
			}
			if (options.autoRespond === false) {
				return;
			}
			setTimeout(() => {
				const response =
					options.respond?.(message) ??
					(message.type === "http_query" && (message.query === "snapshot" || message.query === "state")
						? { status: 200, body: state }
						: { status: 200, body: { ok: true } });
				emit({
					type: "http_response",
					agentName,
					requestId: message.requestId,
					status: response.status,
					body: response.body,
				});
			}, 0);
		},
		on(event, handler) {
			if (event === "message") listeners.add(handler);
		},
		off(event, handler) {
			if (event === "message") listeners.delete(handler);
		},
		emit,
		listenerCount(event) {
			return event === "message" ? listeners.size : 0;
		},
	};
}

interface StartedHub {
	url: string;
	gateway: HubGateway;
	sessionToken: string;
	worker: FakeWorker;
	executorRegistry: ExecutorRegistry;
}

async function startHub(
	agentName = "root",
	state: unknown = { status: "ready", messages: [{ role: "assistant", content: "hello" }] },
	workerOptions: FakeWorkerOptions = {},
): Promise<StartedHub> {
	const workspaceRoot = createTempDir("d-pi-service-gateway-");
	const localUser = createLocalUser(workspaceRoot, { name: "local", description: "Local identity" });
	createAllowedUser(workspaceRoot, {
		name: "server-alias",
		description: "Server approved identity",
		publicKey: localUser.publicKey,
	});
	const worker = createFakeWorker(agentName, state, workerOptions);
	const registry = new AgentRegistry();
	const executorRegistry = new ExecutorRegistry();
	registry.register({
		name: agentName,
		parentName: undefined,
		children: [],
		status: "ready",
		worker: worker as never,
		cwd: workspaceRoot,
	});
	const gateway = new HubGateway(
		registry,
		async () => ({ agentName: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
		executorRegistry,
	);
	gateway.bindAgent(agentName, "connect-123");
	await gateway.start(0);

	const challengeResponse = await fetch(`${gateway.url()}/_hub/auth/challenge`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ publicKey: localUser.publicKey }),
	});
	const challenge = (await challengeResponse.json()) as { challengeId: string; challenge: string };
	const sessionResponse = await fetch(`${gateway.url()}/_hub/auth/session`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			publicKey: localUser.publicKey,
			challengeId: challenge.challengeId,
			signature: signChallenge(localUser, challenge.challenge),
		}),
	});
	const session = (await sessionResponse.json()) as { token: string };
	return { url: gateway.url(), gateway, sessionToken: session.token, worker, executorRegistry };
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

function serviceAuthHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

function findLastPosted(worker: FakeWorker, type: "http_query" | "http_request"): HubToWorkerMessage | undefined {
	for (let i = worker.posted.length - 1; i >= 0; i--) {
		const message = worker.posted[i];
		if (message?.type === type) {
			return message;
		}
	}
	return undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 1000) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function readUntil(stream: ReadableStream<Uint8Array>, expected: string): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes(expected)) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text;
	} finally {
		reader.releaseLock();
	}
}

describe("d-pi service gateway API", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("GET /api/agents/:name/snapshot returns a stable snapshot envelope", async () => {
		const hub = await startHub();
		try {
			const response = await fetch(`${hub.url}/api/agents/root/snapshot`, {
				headers: serviceAuthHeaders(hub.sessionToken),
			});

			expect(response.status).toBe(200);
			await expect(readJson(response)).resolves.toEqual({
				agentName: "root",
				state: { status: "ready", messages: [{ role: "assistant", content: "hello" }] },
			});
			expect(findLastPosted(hub.worker, "http_query")).toMatchObject({
				type: "http_query",
				query: "snapshot",
			});
		} finally {
			await hub.gateway.stop();
		}
	});

	it("POST encoded legacy remote-call uses the decoded agent binding", async () => {
		const hub = await startHub("root agent");
		try {
			hub.executorRegistry.preRegister("connect-123", { cwd: "/tmp" });
			const received: Array<{ event: string; data: unknown }> = [];
			hub.executorRegistry.attachSse("connect-123", {
				send: (event, data) => {
					received.push({ event, data });
					const payload = data as { callId: string };
					void fetch(`${hub.url}/_hub/executor/results`, {
						method: "POST",
						headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
						body: JSON.stringify({
							connectId: "connect-123",
							callId: payload.callId,
							ok: true,
							result: { output: "decoded" },
						}),
					});
				},
			});

			const response = await fetch(`${hub.url}/agents/root%20agent/remote-call`, {
				method: "POST",
				headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
				body: JSON.stringify({ callId: "call-1", tool: "bash", params: { command: "pwd" } }),
			});

			expect(response.status).toBe(200);
			await expect(readJson(response)).resolves.toEqual({ ok: true, result: { output: "decoded" } });
			expect(received).toEqual([
				{ event: "remote-call", data: { callId: "call-1", tool: "bash", params: { command: "pwd" } } },
			]);
		} finally {
			await hub.gateway.stop();
		}
	});

	it("GET encoded legacy proxy routes to the decoded registry agent", async () => {
		const hub = await startHub("root agent");
		try {
			const response = await fetch(`${hub.url}/agents/root%20agent/state`, {
				headers: serviceAuthHeaders(hub.sessionToken),
			});

			expect(response.status).toBe(200);
			await expect(readJson(response)).resolves.toEqual({
				status: "ready",
				messages: [{ role: "assistant", content: "hello" }],
			});
			expect(findLastPosted(hub.worker, "http_query")).toMatchObject({
				type: "http_query",
				query: "state",
			});
		} finally {
			await hub.gateway.stop();
		}
	});

	it("GET encoded legacy events subscribes to the decoded registry agent view model stream", async () => {
		const hub = await startHub("root agent");
		const abort = new AbortController();
		try {
			const response = await fetch(`${hub.url}/agents/root%20agent/events`, {
				headers: serviceAuthHeaders(hub.sessionToken),
				signal: abort.signal,
			});

			expect(response.status).toBe(200);
			if (!response.body) {
				throw new Error("Expected SSE response body");
			}
			const subscribe = hub.worker.posted.find((message) => message.type === "sse_subscribe");
			expect(subscribe).toBeDefined();
			if (subscribe?.type !== "sse_subscribe") {
				throw new Error("Expected sse_subscribe");
			}
			hub.worker.emit({
				type: "sse_event",
				agentName: "root agent",
				subscriberId: subscribe.subscriberId,
				event: "status",
				data: { status: "ready" },
			});
			hub.worker.emit({
				type: "sse_event",
				agentName: "root agent",
				subscriberId: subscribe.subscriberId,
				event: "realtime",
				data: { type: "snapshot", cursor: 1, messages: [{ role: "assistant", content: "hello" }] },
			});
			const firstChunk = await readUntil(response.body, "event: realtime");
			expect(firstChunk).toContain("event: status");
			expect(firstChunk).toContain("event: realtime");
			expect(firstChunk).toContain('"messages":[{"role":"assistant","content":"hello"}]');
		} finally {
			abort.abort();
			await hub.gateway.stop();
		}
	});

	it("returns a stable serialization error when worker snapshot is not JSON-safe", async () => {
		const hub = await startHub("root", { status: "ready", marker: 1n });
		try {
			const response = await fetch(`${hub.url}/api/agents/root/snapshot`, {
				headers: serviceAuthHeaders(hub.sessionToken),
			});

			expect(response.status).toBe(502);
			await expect(readJson(response)).resolves.toEqual({
				error: {
					code: "serialization_error",
					message: "Worker response is not JSON-safe",
				},
			});
		} finally {
			await hub.gateway.stop();
		}
	});

	it("returns a stable serialization error when worker snapshot would change during JSON serialization", async () => {
		const sparseMessages: unknown[] = [];
		sparseMessages[1] = { role: "assistant", content: "hello" };
		const hub = await startHub("root", { status: "ready", messages: sparseMessages });
		try {
			const response = await fetch(`${hub.url}/api/agents/root/snapshot`, {
				headers: serviceAuthHeaders(hub.sessionToken),
			});

			expect(response.status).toBe(502);
			await expect(readJson(response)).resolves.toEqual({
				error: {
					code: "serialization_error",
					message: "Worker response is not JSON-safe",
				},
			});
		} finally {
			await hub.gateway.stop();
		}
	});

	it("POST prompt forwards plain text to the legacy prompt action", async () => {
		const hub = await startHub();
		try {
			const response = await fetch(`${hub.url}/api/agents/root/actions/prompt`, {
				method: "POST",
				headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
				body: JSON.stringify({ text: "hello", options: { images: [{ url: "file:///tmp/a.png" }] } }),
			});

			expect(response.status).toBe(200);
			await expect(readJson(response)).resolves.toEqual({ ok: true });
			const message = findLastPosted(hub.worker, "http_request");
			expect(message).toMatchObject({ type: "http_request", action: "prompt" });
			if (!message || message.type !== "http_request") {
				throw new Error("Expected prompt request");
			}
			const data = message.data as { text: string; options?: unknown };
			expect(data.text).toBe("hello");
			expect(data.options).toEqual({ images: [{ url: "file:///tmp/a.png" }] });
		} finally {
			await hub.gateway.stop();
		}
	});

	it("returns a stable serialization error when worker error body is not JSON-safe", async () => {
		const hub = await startHub("root", { status: "ready" }, { respond: () => ({ status: 500, body: 1n }) });
		try {
			const response = await fetch(`${hub.url}/api/agents/root/actions/prompt`, {
				method: "POST",
				headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
				body: JSON.stringify({ text: "hello" }),
			});

			expect(response.status).toBe(502);
			await expect(readJson(response)).resolves.toEqual({
				error: {
					code: "serialization_error",
					message: "Worker response is not JSON-safe",
				},
			});
		} finally {
			await hub.gateway.stop();
		}
	});

	it("returns a stable serialization error when worker error body would change during JSON serialization", async () => {
		const sparseBody: unknown[] = [];
		sparseBody[1] = "hole";
		const hub = await startHub("root", { status: "ready" }, { respond: () => ({ status: 500, body: sparseBody }) });
		try {
			const response = await fetch(`${hub.url}/api/agents/root/actions/prompt`, {
				method: "POST",
				headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
				body: JSON.stringify({ text: "hello" }),
			});

			expect(response.status).toBe(502);
			await expect(readJson(response)).resolves.toEqual({
				error: {
					code: "serialization_error",
					message: "Worker response is not JSON-safe",
				},
			});
		} finally {
			await hub.gateway.stop();
		}
	});

	it("maps steer and follow-up service actions to legacy action payloads", async () => {
		const hub = await startHub();
		try {
			const steerResponse = await fetch(`${hub.url}/api/agents/root/actions/steer`, {
				method: "POST",
				headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
				body: JSON.stringify({ text: "adjust plan", options: { images: [{ url: "file:///tmp/steer.png" }] } }),
			});
			expect(steerResponse.status).toBe(200);
			await expect(readJson(steerResponse)).resolves.toEqual({ ok: true });
			const steer = findLastPosted(hub.worker, "http_request");
			expect(steer).toMatchObject({
				type: "http_request",
				action: "steer",
				data: { images: [{ url: "file:///tmp/steer.png" }] },
			});
			if (!steer || steer.type !== "http_request") {
				throw new Error("Expected steer request");
			}
			const steerData = steer.data as { text: string; mode?: unknown; options?: unknown };
			expect(steerData.text).toBe("adjust plan");
			expect(steerData.mode).toBeUndefined();
			expect(steerData.options).toBeUndefined();

			const followUpResponse = await fetch(`${hub.url}/api/agents/root/actions/follow-up`, {
				method: "POST",
				headers: { ...serviceAuthHeaders(hub.sessionToken), "Content-Type": "application/json" },
				body: JSON.stringify({ text: "continue", options: { images: [{ url: "file:///tmp/follow-up.png" }] } }),
			});
			expect(followUpResponse.status).toBe(200);
			await expect(readJson(followUpResponse)).resolves.toEqual({ ok: true });
			const followUp = findLastPosted(hub.worker, "http_request");
			expect(followUp).toMatchObject({
				type: "http_request",
				action: "follow-up",
				data: { images: [{ url: "file:///tmp/follow-up.png" }] },
			});
			if (!followUp || followUp.type !== "http_request") {
				throw new Error("Expected follow-up request");
			}
			const followUpData = followUp.data as { text: string; mode?: unknown; options?: unknown };
			expect(followUpData.text).toBe("continue");
			expect(followUpData.mode).toBeUndefined();
			expect(followUpData.options).toBeUndefined();
		} finally {
			await hub.gateway.stop();
		}
	});

	it("GET events emits an initial snapshot and wraps later worker SSE events", async () => {
		const hub = await startHub();
		const abort = new AbortController();
		try {
			const response = await fetch(`${hub.url}/api/agents/root/events`, {
				headers: serviceAuthHeaders(hub.sessionToken),
				signal: abort.signal,
			});
			expect(response.status).toBe(200);
			if (!response.body) {
				throw new Error("Expected SSE response body");
			}
			const firstChunk = await readUntil(response.body, "event: snapshot");
			expect(firstChunk).toContain("event: snapshot");
			expect(firstChunk).toContain('"type":"snapshot"');
			expect(firstChunk).toContain('"agentName":"root"');
			const subscribe = hub.worker.posted.find((message) => message.type === "sse_subscribe");
			expect(subscribe).toBeDefined();
			if (!subscribe || subscribe.type !== "sse_subscribe") {
				throw new Error("Expected SSE subscribe");
			}

			hub.worker.emit({
				type: "sse_event",
				agentName: "root",
				subscriberId: subscribe.subscriberId,
				event: "token",
				data: { text: "hi" },
			});
			const secondChunk = await readUntil(response.body, "event: worker");
			expect(secondChunk).toContain("event: worker");
			expect(secondChunk).toContain('"type":"worker"');
			expect(secondChunk).toContain('"event":"token"');
			expect(secondChunk).toContain('"text":"hi"');

			abort.abort();
			await waitFor(() => hub.worker.posted.some((message) => message.type === "sse_unsubscribe"));
		} finally {
			abort.abort();
			await hub.gateway.stop();
		}
	});

	it("GET events emits a stable serialization error for non JSON-safe worker events", async () => {
		const hub = await startHub();
		const abort = new AbortController();
		try {
			const response = await fetch(`${hub.url}/api/agents/root/events`, {
				headers: serviceAuthHeaders(hub.sessionToken),
				signal: abort.signal,
			});
			expect(response.status).toBe(200);
			if (!response.body) {
				throw new Error("Expected SSE response body");
			}
			await readUntil(response.body, "event: snapshot");
			const subscribe = hub.worker.posted.find((message) => message.type === "sse_subscribe");
			if (!subscribe || subscribe.type !== "sse_subscribe") {
				throw new Error("Expected SSE subscribe");
			}

			hub.worker.emit({
				type: "sse_event",
				agentName: "root",
				subscriberId: subscribe.subscriberId,
				event: "token",
				data: { token: 1n },
			});
			const errorChunk = await readUntil(response.body, "serialization_error");
			expect(errorChunk).toContain("event: worker");
			expect(errorChunk).toContain('"type":"worker"');
			expect(errorChunk).toContain('"event":"serialization_error"');
			expect(errorChunk).toContain('"code":"serialization_error"');
		} finally {
			abort.abort();
			await hub.gateway.stop();
		}
	});

	it("cleans up pending worker response listeners when the client aborts", async () => {
		const hub = await startHub("root", { status: "ready" }, { autoRespond: false });
		const abort = new AbortController();
		try {
			const pending = fetch(`${hub.url}/api/agents/root/snapshot`, {
				headers: serviceAuthHeaders(hub.sessionToken),
				signal: abort.signal,
			});
			await waitFor(() => hub.worker.listenerCount("message") === 1);

			abort.abort();

			await expect(pending).rejects.toThrow();
			await waitFor(() => hub.worker.listenerCount("message") === 0);
		} finally {
			abort.abort();
			await hub.gateway.stop();
		}
	});

	it("returns stable service errors for auth failure and missing agents", async () => {
		const hub = await startHub();
		try {
			const unauthorized = await fetch(`${hub.url}/api/agents/root/snapshot`);
			expect(unauthorized.status).toBe(401);
			await expect(readJson(unauthorized)).resolves.toEqual({
				error: { code: "unauthorized", message: "Unauthorized" },
			});

			const missing = await fetch(`${hub.url}/api/agents/missing/snapshot`, {
				headers: serviceAuthHeaders(hub.sessionToken),
			});
			expect(missing.status).toBe(404);
			await expect(readJson(missing)).resolves.toEqual({
				error: {
					code: "not_found",
					message: "Agent not found: missing",
					details: { agentName: "missing" },
				},
			});
		} finally {
			await hub.gateway.stop();
		}
	});
});
