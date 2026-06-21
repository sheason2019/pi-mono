import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { createConnectSession } from "../src/connect/connect-auth.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";

/**
 * Regression coverage for the auth-fail-does-not-hang bug.
 *
 * Before the fix, a user not in the hub's allow-user list would make
 * `d-pi connect baduser@http://hub` hang indefinitely. Root cause was a
 * server-side ordering bug: `res.writeHead(200, ...)` was called BEFORE
 * `createChallenge(...)`, so when createChallenge threw on the disallowed
 * public key, the response was already half-closed (200 headers, no body)
 * and the catch's 401 hit `ERR_HTTP_HEADERS_SENT`. The client then waited
 * forever for a body that never came.
 *
 * These tests pin down both halves of the fix:
 *   1. Server returns a proper 401 with a JSON body when the public key is
 *      not in the allow-user list.
 *   2. Client `createConnectSession` throws synchronously (no fetch hang)
 *      and the error message names the user + how to fix it.
 *   3. Client has a hard timeout that fires when the server never responds,
 *      so a misbehaving hub cannot pin the CLI forever.
 */

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("d-pi connect auth failure handling", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("hub returns 401 with JSON body when public key is not in allow-user list (no half-closed 200)", async () => {
		const workspaceRoot = createTempDir("d-pi-auth-fail-");
		// Create a local user that is NOT in the allow list.
		createLocalUser(workspaceRoot, { name: "baduser", description: "should be rejected" });

		const gateway = new HubGateway(
			new AgentRegistry(),
			new SourceManager(() => {}),
			async () => ({ agentName: "a" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);

		try {
			// Read the disallowed key directly from the file the test just
			// created. findLocalUserByName isn't exported, so we re-derive it
			// the same way createLocalUser does (one .json per user).
			const { readFileSync } = await import("node:fs");
			const userFile = join(workspaceRoot, "users", "baduser.json");
			const { publicKey } = JSON.parse(readFileSync(userFile, "utf-8")) as { publicKey: string };

			const response = await fetch(`${gateway.url()}/_hub/auth/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicKey }),
			});

			// Pre-fix this was a hang (200 with empty body). Post-fix it is
			// a clean 401 with a JSON body the client can parse.
			expect(response.status).toBe(401);
			const body = (await response.json()) as { error?: string };
			expect(typeof body.error).toBe("string");
			expect(body.error).toMatch(/not allowed/i);
		} finally {
			await gateway.stop();
		}
	});

	it("client createConnectSession throws a clear error naming the user when the hub rejects the public key", async () => {
		const workspaceRoot = createTempDir("d-pi-auth-fail-");
		const localUser = createLocalUser(workspaceRoot, { name: "baduser", description: "x" });
		// Hub's allow-user list is empty — baduser's publicKey is NOT allowed.
		const gateway = new HubGateway(
			new AgentRegistry(),
			new SourceManager(() => {}),
			async () => ({ agentName: "a" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);

		try {
			await expect(
				createConnectSession({
					target: `baduser@${gateway.url()}`,
					localUsersRoot: workspaceRoot,
				}),
			).rejects.toThrowError(/not in allow-user list/);

			// The error should name the user and tell the admin how to add
			// them, so the operator does not have to dig through docs.
			await expect(
				createConnectSession({
					target: `baduser@${gateway.url()}`,
					localUsersRoot: workspaceRoot,
				}),
			).rejects.toThrowError(/baduser/);

			// And include the public key in the remediation so the admin
			// does not have to round-trip back to the client to find it.
			try {
				await createConnectSession({
					target: `baduser@${gateway.url()}`,
					localUsersRoot: workspaceRoot,
				});
				throw new Error("expected throw");
			} catch (err) {
				expect((err as Error).message).toContain(localUser.publicKey);
			}
		} finally {
			await gateway.stop();
		}
	});

	it("client times out cleanly when the hub sends headers but never a body (the original hang case)", async () => {
		// A buggy hub that flushes 200 + Content-Length headers and then sits
		// silent is exactly what produced the original hang. We reproduce it
		// with a raw HTTP server and assert the client bails out well before
		// the user's wait tolerance expires.
		const workspaceRoot = createTempDir("d-pi-auth-fail-");
		createLocalUser(workspaceRoot, { name: "stalleduser", description: "x" });

		const server = createServer((_req, res) => {
			// Write the status line and headers but never call res.end().
			// Node's HTTP server will then keep the socket open and the
			// client will block forever waiting for the body.
			res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
			// Intentionally no res.end() — this is the buggy hub.
		});
		await new Promise<void>((resolve, reject) => {
			server.listen(0, () => resolve());
			server.on("error", reject);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP address");
		const url = `http://127.0.0.1:${address.port}`;

		try {
			const start = Date.now();
			await expect(
				createConnectSession({
					target: `stalleduser@${url}`,
					localUsersRoot: workspaceRoot,
					authTimeoutMs: 1_000, // tight bound so the test is fast
				}),
			).rejects.toThrowError(/(timed out|not JSON)/);
			const elapsed = Date.now() - start;
			// Must fail fast — the whole point of the fix is that the CLI
			// never blocks past the timeout. We allow 2x slack for CI noise.
			expect(elapsed).toBeLessThan(2_000);
		} finally {
			await closeServer(server);
		}
	});

	it("happy path: an allowed user still gets a session token after the fix", async () => {
		// Sanity check that the fix did not regress the success path: a user
		// that IS in the allow-user list must still complete the challenge
		// + session handshake and return a token.
		const workspaceRoot = createTempDir("d-pi-auth-fail-");
		const localUser = createLocalUser(workspaceRoot, { name: "gooduser", description: "x" });
		createAllowedUser(workspaceRoot, {
			name: "gooduser",
			description: "allowed",
			publicKey: localUser.publicKey,
		});

		const gateway = new HubGateway(
			new AgentRegistry(),
			new SourceManager(() => {}),
			async () => ({ agentName: "a" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);

		try {
			const session = await createConnectSession({
				target: `gooduser@${gateway.url()}`,
				localUsersRoot: workspaceRoot,
			});
			expect(session.url).toBe(gateway.url());
			expect(typeof session.token).toBe("string");
			expect(session.token.length).toBeGreaterThan(0);
		} finally {
			await gateway.stop();
		}
	});

	it("session endpoint also returns 401 with a body when the signature is invalid (same ordering bug)", async () => {
		// /_hub/auth/session has the identical ordering bug as /challenge.
		// We pin it here so a future refactor cannot re-introduce the
		// half-closed-200 hang on the second auth hop.
		const workspaceRoot = createTempDir("d-pi-auth-fail-");
		const localUser = createLocalUser(workspaceRoot, { name: "gooduser", description: "x" });
		createAllowedUser(workspaceRoot, {
			name: "gooduser",
			description: "allowed",
			publicKey: localUser.publicKey,
		});

		const gateway = new HubGateway(
			new AgentRegistry(),
			new SourceManager(() => {}),
			async () => ({ agentName: "a" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);

		try {
			// First hop succeeds, then we send a garbage signature. The hub
			// must answer 401 with a JSON body, not a half-closed 200.
			const ch = (await (
				await fetch(`${gateway.url()}/_hub/auth/challenge`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ publicKey: localUser.publicKey }),
				})
			).json()) as { challengeId: string; challenge: string };

			const bad = await fetch(`${gateway.url()}/_hub/auth/session`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					publicKey: localUser.publicKey,
					challengeId: ch.challengeId,
					signature: "not-a-real-signature",
				}),
			});
			expect(bad.status).toBe(401);
			const body = (await bad.json()) as { error?: string };
			expect(typeof body.error).toBe("string");
		} finally {
			await gateway.stop();
		}
	});
});

// Silence unused-import warning when the file is the only consumer of
// signChallenge in a no-server test path. Re-export to keep the helper
// available for ad-hoc debugging.
// biome-ignore lint/suspicious/noExportsInTest: intentional ad-hoc auth debugging helper
export { signChallenge };
