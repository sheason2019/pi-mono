import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { safeIdentifier } from "../shared/schemas.ts";

export interface StoredIdentity {
	name: string;
	description: string;
	publicKey: string;
	createdAt: string;
	updatedAt: string;
}

export const storedIdentitySchema = z.object({
	name: z.string(),
	description: z.string(),
	publicKey: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export function assertValidName(name: string): void {
	safeIdentifier.parse(name);
}

export function readJsonFile<T>(path: string, schema: z.ZodType<T>): T {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	return schema.parse(raw);
}

export function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
}

export function assertFileDoesNotExist(path: string, message: string): void {
	if (existsSync(path)) {
		throw new Error(message);
	}
}

export function userFile(dir: string, name: string): string {
	return join(dir, `${name}.json`);
}

export function nowIso(): string {
	return new Date().toISOString();
}
