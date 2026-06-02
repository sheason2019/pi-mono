import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAllowedUser,
	listAllowedUsers,
	removeAllowedUser,
	updateAllowedUser,
} from "../src/auth/allowed-users.ts";
import { createLocalUser, listLocalUsers, removeLocalUser, updateLocalUser } from "../src/auth/local-users.ts";

let tempDir: string | undefined;

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

describe("d-pi auth stores", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("creates local ed25519 users with optional descriptions", () => {
		const userRoot = createTempDir("d-pi-local-users-");

		const created = createLocalUser(userRoot, { name: "alice", description: "Alice laptop identity" });
		const withoutDescription = createLocalUser(userRoot, { name: "bob", description: "" });

		expect(created.name).toBe("alice");
		expect(created.description).toBe("Alice laptop identity");
		expect(withoutDescription.description).toBe("");
		expect(created.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(created.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(listLocalUsers(userRoot).map((user) => user.name)).toEqual(["alice", "bob"]);
		expect(existsSync(join(userRoot, "users", "alice.json"))).toBe(true);
	});

	it("rejects local users with duplicate names", () => {
		const userRoot = createTempDir("d-pi-local-users-");
		createLocalUser(userRoot, { name: "alice", description: "Alice laptop identity" });

		expect(() => createLocalUser(userRoot, { name: "alice", description: "Duplicate" })).toThrow(
			'Local user "alice" already exists',
		);
	});

	it("updates and removes local users", () => {
		const userRoot = createTempDir("d-pi-local-users-");
		const created = createLocalUser(userRoot, { name: "alice", description: "Alice laptop identity" });

		const updated = updateLocalUser(userRoot, "alice", { description: "Updated Alice laptop" });
		expect(updated).toMatchObject({
			name: "alice",
			description: "Updated Alice laptop",
			publicKey: created.publicKey,
		});
		removeLocalUser(userRoot, "alice");

		expect(listLocalUsers(userRoot)).toEqual([]);
	});

	it("creates allowed users keyed by public key with optional descriptions and rejects duplicate names or keys", () => {
		const workspaceRoot = createTempDir("d-pi-allow-users-");
		const publicKey = "PUB_abc123";

		const created = createAllowedUser(workspaceRoot, {
			name: "alice-server-alias",
			description: "Alice laptop approved for this workspace",
			publicKey,
		});
		const withoutDescription = createAllowedUser(workspaceRoot, {
			name: "bob-server-alias",
			description: "",
			publicKey: "PUB_no_description",
		});

		expect(created).toMatchObject({
			name: "alice-server-alias",
			description: "Alice laptop approved for this workspace",
			publicKey,
			disabled: false,
		});
		expect(withoutDescription.description).toBe("");
		expect(listAllowedUsers(workspaceRoot).map((user) => user.publicKey)).toEqual([publicKey, "PUB_no_description"]);
		expect(existsSync(join(workspaceRoot, "auths", "secrets", "alice-server-alias.json"))).toBe(true);

		expect(() =>
			createAllowedUser(workspaceRoot, {
				name: "alice-server-alias",
				description: "Duplicate name",
				publicKey: "PUB_other",
			}),
		).toThrow('Allowed user "alice-server-alias" already exists');
		expect(() =>
			createAllowedUser(workspaceRoot, {
				name: "different-alias",
				description: "Duplicate key",
				publicKey,
			}),
		).toThrow("Allowed public key is already registered");
	});

	it("updates and removes allowed users", () => {
		const workspaceRoot = createTempDir("d-pi-allow-users-");
		createAllowedUser(workspaceRoot, {
			name: "alice",
			description: "Alice laptop approved",
			publicKey: "PUB_abc123",
		});

		const updated = updateAllowedUser(workspaceRoot, "alice", {
			description: "Updated approval",
			disabled: true,
		});
		expect(updated).toMatchObject({ name: "alice", description: "Updated approval", disabled: true });
		removeAllowedUser(workspaceRoot, "alice");

		expect(listAllowedUsers(workspaceRoot)).toEqual([]);
	});
});
