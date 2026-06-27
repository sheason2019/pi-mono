import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { safeIdentifier } from "../shared/schemas.ts";
import {
	assertFileDoesNotExist,
	nowIso,
	readJsonFile,
	storedIdentitySchema,
	userFile,
	writeJsonFile,
} from "./common.ts";

const allowedUserSchema = storedIdentitySchema.extend({
	disabled: z.boolean(),
});

export type AllowedUser = z.infer<typeof allowedUserSchema>;

export interface CreateAllowedUserOptions {
	name: string;
	description: string;
	publicKey: string;
}

const createAllowedUserOptionsSchema = z.object({
	name: safeIdentifier,
	description: z.string(),
	publicKey: z.string().min(1),
});

function secretsDir(workspaceRoot: string): string {
	return join(workspaceRoot, "auths", "secrets");
}

export function listAllowedUsers(workspaceRoot: string): AllowedUser[] {
	const dir = secretsDir(workspaceRoot);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.map((entry) => readJsonFile(join(dir, entry), allowedUserSchema));
}

export function findAllowedUserByPublicKey(workspaceRoot: string, publicKey: string): AllowedUser | undefined {
	return listAllowedUsers(workspaceRoot).find((user) => user.publicKey === publicKey);
}

export function findAllowedUserByName(workspaceRoot: string, name: string): AllowedUser | undefined {
	return listAllowedUsers(workspaceRoot).find((user) => user.name === name);
}

export function createAllowedUser(workspaceRoot: string, options: CreateAllowedUserOptions): AllowedUser {
	const parsed = createAllowedUserOptionsSchema.parse(options);
	mkdirSync(secretsDir(workspaceRoot), { recursive: true });
	assertFileDoesNotExist(
		userFile(secretsDir(workspaceRoot), parsed.name),
		`Allowed user "${parsed.name}" already exists`,
	);
	if (findAllowedUserByPublicKey(workspaceRoot, parsed.publicKey)) {
		throw new Error("Allowed public key is already registered");
	}
	const createdAt = nowIso();
	const user: AllowedUser = {
		name: parsed.name,
		description: parsed.description,
		publicKey: parsed.publicKey,
		disabled: false,
		createdAt,
		updatedAt: createdAt,
	};
	writeJsonFile(userFile(secretsDir(workspaceRoot), parsed.name), user);
	return user;
}

export function updateAllowedUser(
	workspaceRoot: string,
	name: string,
	options: { description?: string; publicKey?: string; disabled?: boolean },
): AllowedUser {
	const existing = findAllowedUserByName(workspaceRoot, name);
	if (!existing) {
		throw new Error(`Allowed user not found: ${name}`);
	}
	if (options.publicKey !== undefined && !options.publicKey.trim()) {
		throw new Error("public key is required");
	}
	const duplicate = options.publicKey ? findAllowedUserByPublicKey(workspaceRoot, options.publicKey) : undefined;
	if (duplicate && duplicate.name !== name) {
		throw new Error("Allowed public key is already registered");
	}
	const updated: AllowedUser = {
		...existing,
		description: options.description ?? existing.description,
		publicKey: options.publicKey ?? existing.publicKey,
		disabled: options.disabled ?? existing.disabled,
		updatedAt: nowIso(),
	};
	writeJsonFile(userFile(secretsDir(workspaceRoot), name), updated);
	return updated;
}

export function removeAllowedUser(workspaceRoot: string, name: string): void {
	const path = userFile(secretsDir(workspaceRoot), name);
	if (!existsSync(path)) {
		throw new Error(`Allowed user not found: ${name}`);
	}
	rmSync(path);
}
