import type { KnownProvider } from "./types.js";

export function findEnvKeys(provider: KnownProvider): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined;
export function findEnvKeys(_provider: string): string[] | undefined {
	return undefined;
}

export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(_provider: string): string | undefined {
	return undefined;
}
