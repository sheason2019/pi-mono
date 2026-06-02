import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

describe("d-pi auth sessions", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("creates a session by verifying an ed25519 signature for an allowed public key", () => {
		const root = createTempDir("d-pi-auth-session-");
		const localUser = createLocalUser(root, { name: "local-alice", description: "Local Alice key" });
		createAllowedUser(root, {
			name: "workspace-alice",
			description: "Alice approved by workspace",
			publicKey: localUser.publicKey,
		});
		const auth = new AuthSessionManager(root);

		const challenge = auth.createChallenge(localUser.publicKey);
		const signature = signChallenge(localUser, challenge.challenge);
		const session = auth.createSession({
			publicKey: localUser.publicKey,
			challengeId: challenge.challengeId,
			signature,
		});

		expect(session.auth).toEqual({ name: "workspace-alice", description: "Alice approved by workspace" });
		expect(auth.verifyToken(session.token)).toEqual({
			publicKey: localUser.publicKey,
			auth: { name: "workspace-alice", description: "Alice approved by workspace" },
		});
	});

	it("rejects unknown public keys", () => {
		const root = createTempDir("d-pi-auth-session-");
		const localUser = createLocalUser(root, { name: "local-alice", description: "Local Alice key" });
		const auth = new AuthSessionManager(root);

		expect(() => auth.createChallenge(localUser.publicKey)).toThrow("Public key is not allowed");
	});
});
