import { generateKeyPairSync } from "node:crypto";
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

const localUserSchema = storedIdentitySchema.extend({
	privateKey: z.string(),
});

export type LocalUser = z.infer<typeof localUserSchema>;

export interface CreateLocalUserOptions {
	name: string;
	description: string;
}

function usersDir(root: string): string {
	return join(root, "users");
}

function encodeKey(key: Buffer): string {
	return key.toString("base64url");
}

export function listLocalUsers(root: string): LocalUser[] {
	const dir = usersDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.map((entry) => readJsonFile(join(dir, entry), localUserSchema));
}

export function findLocalUserByName(root: string, name: string): LocalUser | undefined {
	return listLocalUsers(root).find((user) => user.name === name);
}

export function createLocalUser(root: string, options: CreateLocalUserOptions): LocalUser {
	safeIdentifier.parse(options.name);
	mkdirSync(usersDir(root), { recursive: true });
	assertFileDoesNotExist(userFile(usersDir(root), options.name), `Local user "${options.name}" already exists`);

	const keyPair = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "der" },
	});
	const createdAt = nowIso();
	const user: LocalUser = {
		name: options.name,
		description: options.description,
		publicKey: encodeKey(keyPair.publicKey),
		privateKey: encodeKey(keyPair.privateKey),
		createdAt,
		updatedAt: createdAt,
	};
	if (listLocalUsers(root).some((existing) => existing.publicKey === user.publicKey)) {
		throw new Error("Local public key is already registered");
	}
	writeJsonFile(userFile(usersDir(root), options.name), user);
	return user;
}

export function updateLocalUser(root: string, name: string, options: { description?: string }): LocalUser {
	const existing = findLocalUserByName(root, name);
	if (!existing) {
		throw new Error(`Local user not found: ${name}`);
	}
	const updated: LocalUser = {
		...existing,
		description: options.description ?? existing.description,
		updatedAt: new Date().toISOString(),
	};
	writeJsonFile(userFile(usersDir(root), name), updated);
	return updated;
}

export function removeLocalUser(root: string, name: string): void {
	const path = userFile(usersDir(root), name);
	if (!existsSync(path)) {
		throw new Error(`Local user not found: ${name}`);
	}
	rmSync(path);
}
