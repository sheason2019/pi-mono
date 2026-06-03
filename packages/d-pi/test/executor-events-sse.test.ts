import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

interface StartedHub {
	url: string;
	gateway: HubGateway;
	executorRegistry: ExecutorRegistry;
	sessionToken: string;
}

async function startHubWithAuth(workspaceRoot: string): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "sse-test", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-sse-test",
		description: "",
		publicKey: localUser.publicKey,
	});
	const executorRegistry = new ExecutorRegistry();
	const gateway = new HubGateway(
		new AgentRegistry(0),
		new SourceManager(() => {}),
		async () => ({ agentId: "created", name: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
		executorRegistry,
	);
	await gateway.start(0);
	const challenge = (await (
		await fetch(`${gateway.url()}/_hub/auth/challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicKey: localUser.publicKey }),
		})
	).json()) as { challengeId: string; challenge: string };
	const session = (await (
		await fetch(`${gateway.url()}/_hub/auth/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				publicKey: localUser.publicKey,
				challengeId: challenge.challengeId,
				signature: signChallenge(localUser, challenge.challenge),
			}),
		})
	).json()) as { token: string };
	return { url: gateway.url(), gateway, executorRegistry, sessionToken: session.token };
}

interface ParsedSseEvent {
	event: string;
	data: string;
}

/** Open an SSE connection via raw http.request and yield parsed events. */
async function* openSse(url: string, headers: Record<string, string>): AsyncGenerator<ParsedSseEvent> {
	const u = new URL(url);
	const req = httpRequest(
		{
			hostname: u.hostname,
			port: u.port,
			path: `${u.pathname}${u.search}`,
			method: "GET",
			headers: { Accept: "text/event-stream", ...headers },
		},
		(res) => {
			if (res.statusCode !== 200) {
				req.destroy(new Error(`SSE returned ${res.statusCode}`));
				return;
			}
			let buffer = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffer += chunk;
				const idx = buffer.indexOf("\n\n");
				while (idx !== -1) {
					const raw = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					let eventName = "message";
					const dataLines: string[] = [];
					for (const line of raw.split("\n")) {
						if (line.startsWith("event: ")) eventName = line.slice(7).trim();
						else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
					}
					if (dataLines.length > 0) {
						// Push event to the consumer via a promise that we resolve.
						// The consumer's for-await will pick it up.
						queue.push({ event: eventName, data: dataLines.join("\n") });
						for (const r of pendingResolvers) r();
						pendingResolvers = [];
					}
				}
			});
			res.on("end", () => {
				closed = true;
				for (const r of pendingResolvers) r();
				pendingResolvers = [];
			});
			res.on("error", (err) => {
				req.destroy(err);
			});
		},
	);
	req.on("error", (_err) => {
		queue.push(null);
		for (const r of pendingResolvers) r();
		pendingResolvers = [];
	});
	let closed = false;
	const queue: Array<ParsedSseEvent | null> = [];
	let pendingResolvers: Array<() => void> = [];
	req.end();
	try {
		while (true) {
			if (queue.length > 0) {
				const ev = queue.shift()!;
				if (ev === null) return;
				yield ev;
			} else if (closed) {
				return;
			} else {
				await new Promise<void>((resolve) => pendingResolvers.push(resolve));
			}
		}
	} finally {
		req.destroy();
	}
}

describe("hub endpoint GET /_hub/executor/events (SSE)", () => {
	beforeEach(() => {
		createTempDir("d-pi-exec-events-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("sends a connected event on subscribe and forwards sseConn.send events", async () => {
		const { url, gateway, executorRegistry, sessionToken } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c1", { cwd: "/tmp" });

			const sseIter = openSse(`${url}/_hub/executor/events?connectId=c1`, {
				Authorization: `Bearer ${sessionToken}`,
			});
			const first = (await sseIter.next()).value as ParsedSseEvent;
			expect(first).toBeDefined();
			expect(first.event).toBe("connected");
			expect(JSON.parse(first.data)).toEqual({ connectId: "c1" });

			// Wait for attach to complete.
			let handle = executorRegistry.get("c1");
			for (let i = 0; i < 50; i++) {
				if (handle?.attached) break;
				await new Promise((r) => setTimeout(r, 10));
				handle = executorRegistry.get("c1");
			}
			expect(handle?.attached).toBe(true);

			handle?.sseConn?.send("remote-call", { callId: "x", tool: "bash", params: { command: "ls" } });
			const second = (await sseIter.next()).value as ParsedSseEvent;
			expect(second.event).toBe("remote-call");
			expect(JSON.parse(second.data)).toEqual({
				callId: "x",
				tool: "bash",
				params: { command: "ls" },
			});

			await sseIter.return(undefined);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 404 when connectId is not pre-registered", async () => {
		const { url, gateway, sessionToken } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/_hub/executor/events?connectId=missing`, {
				headers: { Authorization: `Bearer ${sessionToken}` },
			});
			expect(res.status).toBe(404);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 400 when connectId query param is missing", async () => {
		const { url, gateway, sessionToken } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/_hub/executor/events`, {
				headers: { Authorization: `Bearer ${sessionToken}` },
			});
			expect(res.status).toBe(400);
		} finally {
			await gateway.stop();
		}
	});

	it("returns 401 without auth", async () => {
		const { url, gateway } = await startHubWithAuth(tempDir!);
		try {
			const res = await fetch(`${url}/_hub/executor/events?connectId=c1`);
			expect(res.status).toBe(401);
		} finally {
			await gateway.stop();
		}
	});

	it("deregisters the executor when the SSE connection closes", async () => {
		const { url, gateway, executorRegistry, sessionToken } = await startHubWithAuth(tempDir!);
		try {
			executorRegistry.preRegister("c2", { cwd: "/tmp" });
			const sseIter = openSse(`${url}/_hub/executor/events?connectId=c2`, {
				Authorization: `Bearer ${sessionToken}`,
			});
			// Read the connected event (proves the SSE is open).
			const ev = (await sseIter.next()).value as ParsedSseEvent;
			expect(ev.event).toBe("connected");
			expect(executorRegistry.get("c2")).toBeDefined();
			// Close the connection.
			await sseIter.return(undefined);
			// Wait for deregister on req close.
			for (let i = 0; i < 100; i++) {
				if (!executorRegistry.get("c2")) break;
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(executorRegistry.get("c2")).toBeUndefined();
		} finally {
			await gateway.stop();
		}
	});
});
