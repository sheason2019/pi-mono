import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { bindAgentOnHub, buildExecutorChildArgs } from "../src/connect/connect-mode.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

describe("buildExecutorChildArgs", () => {
	it("uses tsx when cliPath is a .ts file", () => {
		expect(buildExecutorChildArgs("/abs/path/d-pi.ts")).toEqual([
			"--import",
			"tsx",
			"/abs/path/d-pi.ts",
			"_executor-child",
		]);
	});

	it("invokes the binary directly when cliPath is a built script", () => {
		expect(buildExecutorChildArgs("/usr/local/bin/d-pi")).toEqual(["/usr/local/bin/d-pi", "_executor-child"]);
	});
});

describe("bindAgentOnHub", () => {
	let bindUrl: string;
	let bindToken: string;
	let bindGateway: HubGateway;
	beforeEach(async () => {
		createTempDir("d-pi-bind-");
		const localUser = createLocalUser(tempDir!, { name: "u", description: "" });
		createAllowedUser(tempDir!, { name: "u", description: "", publicKey: localUser.publicKey });
		const execReg = new ExecutorRegistry();
		const gateway = new HubGateway(
			new AgentRegistry(),
			new SourceManager(() => {}),
			async () => ({ agentName: "a" }),
			async () => {},
			new AuthSessionManager(tempDir!),
			execReg,
		);
		await gateway.start(0);
		bindUrl = gateway.url();
		bindGateway = gateway;
		const ch = (await (
			await fetch(`${bindUrl}/_hub/auth/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicKey: localUser.publicKey }),
			})
		).json()) as { challengeId: string; challenge: string };
		const session = (await (
			await fetch(`${bindUrl}/_hub/auth/session`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					publicKey: localUser.publicKey,
					challengeId: ch.challengeId,
					signature: signChallenge(localUser, ch.challenge),
				}),
			})
		).json()) as { token: string };
		bindToken = session.token;
	});
	afterEach(async () => {
		await bindGateway.stop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("POSTs to /_hub/agents/{id}/bind with the connect id and bearer auth", async () => {
		await bindAgentOnHub(bindUrl, bindToken, "agent-1", "connect-1");

		const res = await fetch(`${bindUrl}/agents/agent-1/remote-call`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bindToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Executor not available/i);
	});

	it("omits the Authorization header when no token is provided (dev mode)", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(u), init });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		await bindAgentOnHub("http://hub", undefined, "agent-2", "connect-2", fetchImpl);
		expect(calls).toHaveLength(1);
		const init = calls[0]!.init!;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("throws when the hub returns non-2xx", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
		await expect(bindAgentOnHub("http://hub", "tok", "a", "c", fetchImpl)).rejects.toThrow(/500/);
	});
});
