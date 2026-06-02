import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StoredIdentity {
	name: string;
	description: string;
	publicKey: string;
	createdAt: string;
	updatedAt: string;
}

export function assertValidName(name: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		throw new Error("user name may only contain letters, numbers, dots, underscores, and dashes");
	}
}

export function readJsonFile<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
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
