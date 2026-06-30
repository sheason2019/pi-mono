import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalUser } from "../src/auth/local-users.ts";
import { createConnectSession } from "../src/connect/connect-auth.ts";
import { buildConnectChildArgs } from "../src/connect/connect-mode.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

describe("d-pi connect auth", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("creates a session token for a local user alias and preserves base URL paths", async () => {
		const userRoot = createTempDir("d-pi-connect-auth-");
		const localUser = createLocalUser(userRoot, { name: "alice", description: "Alice local key" });
		const calls: Array<{ url: string; body: unknown }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url: String(url), body });
			if (String(url).endsWith("/api/auth/challenge")) {
				return new Response(JSON.stringify({ challengeId: "challenge-1", challenge: "sign-me" }), { status: 200 });
			}
			return new Response(JSON.stringify({ token: "session-token" }), { status: 200 });
		});

		const session = await createConnectSession({
			target: "alice@https://example.com/dpi",
			localUsersRoot: userRoot,
			fetchImpl,
		});

		expect(session).toEqual({ url: "https://example.com/dpi", token: "session-token" });
		expect(calls[0]).toEqual({
			url: "https://example.com/dpi/api/auth/challenge",
			body: { publicKey: localUser.publicKey },
		});
		expect(calls[1]?.url).toBe("https://example.com/dpi/api/auth/session");
		expect(calls[1]?.body).toMatchObject({
			publicKey: localUser.publicKey,
			challengeId: "challenge-1",
		});
		expect((calls[1]?.body as { signature?: string }).signature).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("does not require tsx when spawning from built JavaScript", () => {
		expect(buildConnectChildArgs("/usr/local/bin/d-pi", "http://hub/agents/root", "http://hub")).toEqual([
			"/usr/local/bin/d-pi",
			"_connect-child",
			"http://hub/agents/root",
			"http://hub",
		]);
	});
});
