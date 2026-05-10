import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ROOT_AGENT_ID } from "../agents/types.js";
import { getAuthConfigPath, getLocalPiDir } from "../config.js";

const AUTH_FILE_VERSION = 1;
const ROOT_TOKEN_ID = "root";
const TOKEN_PREFIX = "dpi";
const ROOT_TOKEN_USER = "root";
const ROOT_TOKEN_PURPOSE = "full hub administration";

export interface StoredAuthToken {
	id: string;
	name: string;
	description: string;
	user: string;
	purpose: string;
	scopeRootAgentId: string;
	createdByAgentId: string;
	createdAt: string;
	lastUsedAt?: string;
	/**
	 * Plaintext token. Authentication is now a direct equality check: scrypt hashing
	 * was removed because the root token was already stored in plaintext anyway, so
	 * the per-token scrypt cost only delayed `peer:hello` without adding any practical
	 * defense beyond filesystem permissions on `.pi/auth.json`.
	 */
	token: string;
	root?: boolean;
}

export interface HubAuthFile {
	version: 1;
	tokens: StoredAuthToken[];
}

export interface HubAuthIdentity {
	id: string;
	name: string;
	description: string;
	user: string;
	purpose: string;
	scopeRootAgentId: string;
	createdByAgentId: string;
	root: boolean;
}

export interface EnsureRootTokenResult {
	record: StoredAuthToken;
	token: string;
}

export interface CreateScopedTokenInput {
	name: string;
	description: string;
	user: string;
	purpose: string;
	scopeRootAgentId: string;
	createdByAgentId: string;
}

export interface CreatedScopedToken {
	record: StoredAuthToken;
	token: string;
}

interface ParsedAuthFile {
	file: HubAuthFile;
	cleaned: boolean;
}

function createTokenSecret(): string {
	return `${TOKEN_PREFIX}_${randomBytes(24).toString("base64url")}`;
}

function assertNonEmptyTokenField(value: string, fieldName: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`Token ${fieldName} is required.`);
	}
	return trimmed;
}

function parseAuthFile(raw: string, path: string): ParsedAuthFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in auth registry ${path}: ${message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid auth registry shape in ${path}`);
	}
	const obj = parsed as { version?: unknown; tokens?: unknown };
	if (obj.version !== AUTH_FILE_VERSION || !Array.isArray(obj.tokens)) {
		throw new Error(`Unsupported auth registry version in ${path}`);
	}
	const tokens: StoredAuthToken[] = [];
	const ids = new Set<string>();
	let cleaned = false;
	for (const rawToken of obj.tokens) {
		if (typeof rawToken !== "object" || rawToken === null || Array.isArray(rawToken)) {
			throw new Error(`Invalid auth token entry in ${path}`);
		}
		const token = rawToken as Partial<Record<keyof StoredAuthToken, unknown>> & { hash?: unknown };
		if (
			typeof token.id !== "string" ||
			typeof token.name !== "string" ||
			typeof token.description !== "string" ||
			typeof token.scopeRootAgentId !== "string" ||
			typeof token.createdByAgentId !== "string" ||
			typeof token.createdAt !== "string"
		) {
			throw new Error(`Invalid auth token metadata in ${path}`);
		}
		if (ids.has(token.id)) {
			throw new Error(`Duplicate auth token id in ${path}: ${token.id}`);
		}
		ids.add(token.id);
		if (typeof token.token !== "string" || token.token.length === 0) {
			// Legacy entries that only stored a scrypt hash cannot be authenticated under the
			// plaintext-compare scheme. Skip them silently; the operator can regenerate via
			// `dpi token create` if they still need that token.
			cleaned = true;
			continue;
		}
		const isRootToken = token.id === ROOT_TOKEN_ID || token.root === true;
		const user = typeof token.user === "string" && token.user.trim() ? token.user.trim() : undefined;
		const purpose = typeof token.purpose === "string" && token.purpose.trim() ? token.purpose.trim() : undefined;
		if ((!user || !purpose) && !isRootToken) {
			// Non-root tokens without an explicit human/audience identity are unsafe for guest access.
			cleaned = true;
			continue;
		}
		tokens.push({
			id: token.id,
			name: token.name,
			description: token.description,
			user: user ?? ROOT_TOKEN_USER,
			purpose: purpose ?? ROOT_TOKEN_PURPOSE,
			scopeRootAgentId: token.scopeRootAgentId,
			createdByAgentId: token.createdByAgentId,
			createdAt: token.createdAt,
			...(typeof token.lastUsedAt === "string" ? { lastUsedAt: token.lastUsedAt } : {}),
			token: token.token,
			...(token.root === true ? { root: true } : {}),
		});
	}
	return { file: { version: AUTH_FILE_VERSION, tokens }, cleaned };
}

function identityFromRecord(record: StoredAuthToken): HubAuthIdentity {
	return {
		id: record.id,
		name: record.name,
		description: record.description,
		user: record.user,
		purpose: record.purpose,
		scopeRootAgentId: record.scopeRootAgentId,
		createdByAgentId: record.createdByAgentId,
		root: record.root === true,
	};
}

export class HubAuthTokenStore {
	private readonly path: string;
	private file: HubAuthFile;
	/** Plaintext token -> record for O(1) authenticate. */
	private readonly tokensByPlaintext = new Map<string, StoredAuthToken>();

	private constructor(
		private readonly cwd: string,
		file: HubAuthFile,
	) {
		this.path = getAuthConfigPath(cwd);
		this.file = file;
		for (const record of this.file.tokens) {
			this.tokensByPlaintext.set(record.token, record);
		}
	}

	static open(cwd: string): HubAuthTokenStore {
		const path = getAuthConfigPath(cwd);
		if (!existsSync(path)) {
			return new HubAuthTokenStore(cwd, { version: AUTH_FILE_VERSION, tokens: [] });
		}
		const parsed = parseAuthFile(readFileSync(path, "utf8"), path);
		const store = new HubAuthTokenStore(cwd, parsed.file);
		if (parsed.cleaned) {
			store.save();
		}
		return store;
	}

	ensureRootToken(): EnsureRootTokenResult {
		const existing = this.file.tokens.find((token) => token.id === ROOT_TOKEN_ID);
		if (existing) {
			if (typeof existing.token === "string" && existing.token.trim().length > 0) {
				this.tokensByPlaintext.set(existing.token, existing);
				return { record: existing, token: existing.token };
			}
			const token = createTokenSecret();
			existing.token = token;
			existing.root = true;
			this.tokensByPlaintext.set(token, existing);
			this.save();
			return { record: existing, token };
		}
		const token = createTokenSecret();
		const record: StoredAuthToken = {
			id: ROOT_TOKEN_ID,
			name: "root",
			description: "Root access for the full D-Pi agent tree.",
			user: ROOT_TOKEN_USER,
			purpose: ROOT_TOKEN_PURPOSE,
			scopeRootAgentId: ROOT_AGENT_ID,
			createdByAgentId: ROOT_AGENT_ID,
			createdAt: new Date().toISOString(),
			token,
			root: true,
		};
		this.file.tokens.push(record);
		this.tokensByPlaintext.set(token, record);
		this.save();
		return { record, token };
	}

	createScopedToken(input: CreateScopedTokenInput): CreatedScopedToken {
		const name = assertNonEmptyTokenField(input.name, "name");
		const description = assertNonEmptyTokenField(input.description, "description");
		const user = assertNonEmptyTokenField(input.user, "user");
		const purpose = assertNonEmptyTokenField(input.purpose, "purpose");
		const token = createTokenSecret();
		const id = `token-${randomBytes(8).toString("hex")}`;
		const record: StoredAuthToken = {
			id,
			name,
			description,
			user,
			purpose,
			scopeRootAgentId: input.scopeRootAgentId,
			createdByAgentId: input.createdByAgentId,
			createdAt: new Date().toISOString(),
			token,
		};
		this.file.tokens.push(record);
		this.tokensByPlaintext.set(token, record);
		this.save();
		return { record, token };
	}

	authenticate(token: string): HubAuthIdentity | undefined {
		const trimmed = token.trim();
		if (!trimmed) {
			return undefined;
		}
		const record = this.tokensByPlaintext.get(trimmed);
		if (!record) {
			return undefined;
		}
		record.lastUsedAt = new Date().toISOString();
		this.save();
		return identityFromRecord(record);
	}

	getMetadata(tokenId: string): HubAuthIdentity | undefined {
		const id = tokenId.trim();
		if (!id) {
			return undefined;
		}
		const record = this.file.tokens.find((entry) => entry.id === id);
		return record ? identityFromRecord(record) : undefined;
	}

	revokeToken(tokenId: string): HubAuthIdentity | undefined {
		const id = tokenId.trim();
		if (!id) {
			return undefined;
		}
		const index = this.file.tokens.findIndex((entry) => entry.id === id);
		if (index < 0) {
			return undefined;
		}
		const record = this.file.tokens[index]!;
		if (record.root === true || record.id === ROOT_TOKEN_ID) {
			throw new Error("Cannot revoke the root token.");
		}
		this.file.tokens.splice(index, 1);
		this.tokensByPlaintext.delete(record.token);
		this.save();
		return identityFromRecord(record);
	}

	revokeTokensScopedTo(scopeRootAgentIds: Iterable<string>): HubAuthIdentity[] {
		const scopes = new Set([...scopeRootAgentIds].map((id) => id.trim()).filter((id) => id.length > 0));
		if (scopes.size === 0) {
			return [];
		}
		const kept: StoredAuthToken[] = [];
		const revoked: HubAuthIdentity[] = [];
		for (const record of this.file.tokens) {
			if (record.root === true || record.id === ROOT_TOKEN_ID || !scopes.has(record.scopeRootAgentId)) {
				kept.push(record);
				continue;
			}
			revoked.push(identityFromRecord(record));
			this.tokensByPlaintext.delete(record.token);
		}
		if (revoked.length === 0) {
			return [];
		}
		this.file = { ...this.file, tokens: kept };
		this.save();
		return revoked;
	}

	listMetadata(): HubAuthIdentity[] {
		return this.file.tokens.map((record) => identityFromRecord(record));
	}

	save(): void {
		mkdirSync(getLocalPiDir(this.cwd), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
	}
}
