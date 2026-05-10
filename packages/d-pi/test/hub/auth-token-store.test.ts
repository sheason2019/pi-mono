import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HubAuthTokenStore } from "../../src/hub/auth/token-store.js";
import { getAuthConfigPath, getLocalPiDir } from "../../src/hub/config.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("HubAuthTokenStore", () => {
	it("persists the root token plaintext so hub serve can display it continuously", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-root-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);

		const created = store.ensureRootToken();

		expect(created.token).toMatch(/^dpi_/);
		expect(created.record.scopeRootAgentId).toBe("root");
		expect(created.record.user).toBe("root");
		expect(created.record.purpose).toBe("full hub administration");
		expect(created.record.root).toBe(true);
		expect(existsSync(getAuthConfigPath(cwd))).toBe(true);
		const raw = readFileSync(getAuthConfigPath(cwd), "utf8");
		expect(raw).toContain(created.token);
		expect(raw).not.toContain("scrypt:v1");

		const reopened = HubAuthTokenStore.open(cwd);
		expect(reopened.ensureRootToken().token).toBe(created.token);
		expect(reopened.authenticate(created.token)).toMatchObject({
			name: "root",
			user: "root",
			purpose: "full hub administration",
		});
		expect(reopened.authenticate("wrong-token")).toBeUndefined();
	});

	it("creates scoped named tokens with plaintext storage and authenticates them after reopen", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-scoped-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);
		store.ensureRootToken();

		const created = store.createScopedToken({
			name: "web guests",
			description: "Temporary Web UI access for child-a",
			user: "Li Xujie",
			purpose: "Temporary Web UI guest access for code review.",
			scopeRootAgentId: "child-a",
			createdByAgentId: "child-a",
		});

		const identity = HubAuthTokenStore.open(cwd).authenticate(created.token);
		expect(identity).toEqual({
			id: created.record.id,
			name: "web guests",
			description: "Temporary Web UI access for child-a",
			user: "Li Xujie",
			purpose: "Temporary Web UI guest access for code review.",
			scopeRootAgentId: "child-a",
			createdByAgentId: "child-a",
			root: false,
		});
		expect(readFileSync(getAuthConfigPath(cwd), "utf8")).toContain(created.token);
	});

	it("revokes scoped tokens from memory and disk", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-revoke-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);
		store.ensureRootToken();
		const created = store.createScopedToken({
			name: "guest",
			description: "Guest access",
			user: "Guest",
			purpose: "Review",
			scopeRootAgentId: "child-a",
			createdByAgentId: "child-a",
		});

		const revoked = store.revokeToken(created.record.id);

		expect(revoked).toMatchObject({ id: created.record.id, name: "guest" });
		expect(store.authenticate(created.token)).toBeUndefined();
		expect(store.listMetadata().some((entry) => entry.id === created.record.id)).toBe(false);
		expect(readFileSync(getAuthConfigPath(cwd), "utf8")).not.toContain(created.token);
		expect(HubAuthTokenStore.open(cwd).authenticate(created.token)).toBeUndefined();
	});

	it("refuses to revoke the root token", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-revoke-root-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);
		const root = store.ensureRootToken();

		expect(() => store.revokeToken(root.record.id)).toThrow(/root token/i);
		expect(store.authenticate(root.token)).toMatchObject({ id: root.record.id, root: true });
	});

	it("authenticates root, scoped, and rejects unknown/empty tokens", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-mix-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);
		const root = store.ensureRootToken();
		const scoped = store.createScopedToken({
			name: "child token",
			description: "scoped",
			user: "Child User",
			purpose: "Child scoped access.",
			scopeRootAgentId: "child-a",
			createdByAgentId: "child-a",
		});

		const reopened = HubAuthTokenStore.open(cwd);
		expect(reopened.authenticate(root.token)).toMatchObject({ name: "root", root: true });
		expect(reopened.authenticate(scoped.token)).toMatchObject({
			id: scoped.record.id,
			name: "child token",
			user: "Child User",
			purpose: "Child scoped access.",
			root: false,
		});
		expect(reopened.authenticate("nope")).toBeUndefined();
		expect(reopened.authenticate("")).toBeUndefined();
		expect(reopened.authenticate("   ")).toBeUndefined();
	});

	it("skips legacy hash-only tokens silently so they do not block authenticate()", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-legacy-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);
		store.ensureRootToken();

		const path = getAuthConfigPath(cwd);
		const original = JSON.parse(readFileSync(path, "utf8")) as {
			version: 1;
			tokens: Array<Record<string, unknown>>;
		};
		original.tokens.push({
			id: "legacy",
			name: "legacy hash-only",
			description: "Pre-plaintext entry without a stored token field",
			user: "test-user",
			purpose: "test access",
			scopeRootAgentId: "child-a",
			createdByAgentId: "child-a",
			createdAt: new Date().toISOString(),
			hash: "scrypt:v1:salt:digest",
		});
		const dir = getLocalPiDir(cwd);
		writeFileSync(path, JSON.stringify(original, null, 2), "utf8");
		expect(existsSync(dir)).toBe(true);

		const reopened = HubAuthTokenStore.open(cwd);
		expect(reopened.listMetadata().some((entry) => entry.id === "legacy")).toBe(false);
	});

	it("does not authenticate legacy plaintext non-root tokens without user and purpose metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-auth-legacy-identity-"));
		tempDirs.push(cwd);
		const store = HubAuthTokenStore.open(cwd);
		store.ensureRootToken();

		const path = getAuthConfigPath(cwd);
		const original = JSON.parse(readFileSync(path, "utf8")) as {
			version: 1;
			tokens: Array<Record<string, unknown>>;
		};
		original.tokens.push({
			id: "legacy-guest",
			name: "guest",
			description: "Guest token missing identity fields",
			scopeRootAgentId: "root",
			createdByAgentId: "root",
			createdAt: new Date().toISOString(),
			token: "dpi_legacy_guest_token",
		});
		writeFileSync(path, JSON.stringify(original, null, 2), "utf8");

		const reopened = HubAuthTokenStore.open(cwd);
		expect(reopened.authenticate("dpi_legacy_guest_token")).toBeUndefined();
		expect(reopened.listMetadata().some((entry) => entry.id === "legacy-guest")).toBe(false);
		expect(readFileSync(path, "utf8")).not.toContain("dpi_legacy_guest_token");
	});
});
