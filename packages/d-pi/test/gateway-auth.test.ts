import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import type { WorkerToHubMessage } from "../src/types.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

/**
 * Minimal mock worker that simulates the IPC path: receives
 * http_request/http_query via postMessage, and sends http_response
 * back via the on("message") listeners that the gateway attaches.
 *
 * The `onPrompt` callback lets each test capture the forwarded
 * prompt body for assertion.
 */
function createMockWorker(onPrompt?: (body: { text?: string }) => void) {
	const listeners = new Set<(message: WorkerToHubMessage) => void>();
	const worker = {
		postMessage(message: unknown) {
			const msg = message as { type: string; requestId: string; action?: string; query?: string; data?: unknown };
			// Defer the response to the next tick so the gateway has time
			// to attach its on("message") listener before we emit.
			setTimeout(() => {
				if (msg.type === "http_request" && msg.action === "prompt") {
					onPrompt?.(msg.data as { text?: string });
					for (const listener of listeners) {
						listener({
							type: "http_response",
							agentName: "agent-1",
							requestId: msg.requestId,
							status: 200,
							body: { ok: true },
						} satisfies WorkerToHubMessage);
					}
				} else if (msg.type === "http_query") {
					for (const listener of listeners) {
						listener({
							type: "http_response",
							agentName: "agent-1",
							requestId: msg.requestId,
							status: 200,
							body: {},
						} satisfies WorkerToHubMessage);
					}
				}
			}, 0);
		},
		on(event: string, handler: (message: WorkerToHubMessage) => void) {
			if (event === "message") listeners.add(handler);
		},
		off(event: string, handler: (message: WorkerToHubMessage) => void) {
			if (event === "message") listeners.delete(handler);
		},
	};
	return worker;
}

describe("d-pi gateway auth", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("requires a session token for hub APIs after public-key challenge auth", async () => {
		const workspaceRoot = createTempDir("d-pi-gateway-auth-");
		const localUser = createLocalUser(workspaceRoot, { name: "local", description: "Local identity" });
		createAllowedUser(workspaceRoot, {
			name: "allowed-local",
			description: "Allowed local identity",
			publicKey: localUser.publicKey,
		});
		const registry = new AgentRegistry();
		const gateway = new HubGateway(
			registry,
			async () => ({ agentName: "created" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);
		const url = gateway.url();

		try {
			const unauthorized = await fetch(`${url}/api/network`);
			expect(unauthorized.status).toBe(401);

			const challengeResponse = await fetch(`${url}/api/auth/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicKey: localUser.publicKey }),
			});
			expect(challengeResponse.status).toBe(200);
			const challenge = (await challengeResponse.json()) as { challengeId: string; challenge: string };
			const sessionResponse = await fetch(`${url}/api/auth/session`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					publicKey: localUser.publicKey,
					challengeId: challenge.challengeId,
					signature: signChallenge(localUser, challenge.challenge),
				}),
			});
			expect(sessionResponse.status).toBe(200);
			const session = (await sessionResponse.json()) as { token: string };

			const authorized = await fetch(`${url}/api/team`, {
				headers: { Authorization: `Bearer ${session.token}` },
			});
			expect(authorized.status).toBe(200);
		} finally {
			await gateway.stop();
		}
	});

	it("injects server allow-user auth details into connect prompt meta", async () => {
		const workspaceRoot = createTempDir("d-pi-gateway-auth-");
		const localUser = createLocalUser(workspaceRoot, { name: "local", description: "Local identity" });
		createAllowedUser(workspaceRoot, {
			name: "server-alias",
			description: "Server approved identity",
			publicKey: localUser.publicKey,
		});
		let forwardedText = "";
		const mockWorker = createMockWorker((body) => {
			forwardedText = body.text ?? "";
		});
		const registry = new AgentRegistry();
		registry.register({
			name: "agent-1",
			parentName: undefined,
			children: [],
			status: "ready",
			plan: [],
			worker: mockWorker as never,
			cwd: workspaceRoot,
		});
		const gateway = new HubGateway(
			registry,
			async () => ({ agentName: "created" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);

		try {
			const challengeResponse = await fetch(`${gateway.url()}/api/auth/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicKey: localUser.publicKey }),
			});
			const challenge = (await challengeResponse.json()) as { challengeId: string; challenge: string };
			const sessionResponse = await fetch(`${gateway.url()}/api/auth/session`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					publicKey: localUser.publicKey,
					challengeId: challenge.challengeId,
					signature: signChallenge(localUser, challenge.challenge),
				}),
			});
			const session = (await sessionResponse.json()) as { token: string };

			const promptResponse = await fetch(`${gateway.url()}/agents/agent-1/prompt`, {
				method: "POST",
				headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					text: "hello",
					auth: { name: "forged", description: "forged" },
				}),
			});

			expect(promptResponse.status).toBe(200);
			expect(forwardedText).toContain("hello");
			expect(forwardedText).toContain('"auth":{"name":"server-alias","description":"Server approved identity"}');
			expect(forwardedText).not.toContain("forged");
		} finally {
			await gateway.stop();
		}
	});
});
