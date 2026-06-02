import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import type { AgentRecord } from "../src/types.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

async function startGateway(workspaceRoot: string): Promise<{ url: string; gateway: HubGateway }> {
	const registry = new AgentRegistry(19091);
	const sourceManager = new SourceManager(() => {});
	const gateway = new HubGateway(
		registry,
		sourceManager,
		async () => ({ agentId: "created", name: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
	);
	await gateway.start(0);
	return { url: gateway.url(), gateway };
}

async function startAgentServer(
	onPrompt: (body: { text?: string }) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/prompt") {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				onPrompt(JSON.parse(Buffer.concat(chunks).toString()) as { text?: string });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.listen(0, resolve);
		server.on("error", reject);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	return { port: address.port, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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
		const { url, gateway } = await startGateway(workspaceRoot);

		try {
			const unauthorized = await fetch(`${url}/_hub/network`);
			expect(unauthorized.status).toBe(401);

			const challengeResponse = await fetch(`${url}/_hub/auth/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicKey: localUser.publicKey }),
			});
			expect(challengeResponse.status).toBe(200);
			const challenge = (await challengeResponse.json()) as { challengeId: string; challenge: string };
			const sessionResponse = await fetch(`${url}/_hub/auth/session`, {
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

			const authorized = await fetch(`${url}/_hub/network`, {
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
		const agentServer = await startAgentServer((body) => {
			forwardedText = body.text ?? "";
		});
		const registry = new AgentRegistry(19091);
		registry.register({
			id: "agent-1",
			name: "root",
			parentId: undefined,
			children: [],
			port: agentServer.port,
			status: "ready",
			worker: {} as AgentRecord["worker"],
			cwd: workspaceRoot,
			model: undefined,
		});
		const gateway = new HubGateway(
			registry,
			new SourceManager(() => {}),
			async () => ({ agentId: "created", name: "created" }),
			async () => {},
			new AuthSessionManager(workspaceRoot),
		);
		await gateway.start(0);

		try {
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
			await agentServer.close();
		}
	});
});
