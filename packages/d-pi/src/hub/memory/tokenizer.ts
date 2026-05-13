import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

const TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;
const HAN_PATTERN = /\p{Script=Han}/u;
const jieba = Jieba.withDict(dict);

function normalizeToken(token: string): string | undefined {
	const normalized = token.trim().toLocaleLowerCase();
	if (!normalized || !TOKEN_PATTERN.test(normalized)) {
		TOKEN_PATTERN.lastIndex = 0;
		return undefined;
	}
	TOKEN_PATTERN.lastIndex = 0;
	return normalized;
}

export function tokenizeMemoryText(text: string): string[] {
	const tokens = new Set<string>();
	for (const token of text.match(TOKEN_PATTERN) ?? []) {
		const normalized = normalizeToken(token);
		if (normalized) {
			tokens.add(normalized);
		}
	}
	for (const token of jieba.cutForSearch(text)) {
		const normalized = normalizeToken(token);
		if (normalized) {
			tokens.add(normalized);
		}
	}
	return [...tokens];
}

function tokenizeMemoryQuery(query: string): string[] {
	const tokens = new Set<string>();
	for (const token of jieba.cutForSearch(query)) {
		const normalized = normalizeToken(token);
		if (normalized && (normalized.length > 1 || HAN_PATTERN.test(normalized))) {
			tokens.add(normalized);
		}
	}
	for (const token of query.match(TOKEN_PATTERN) ?? []) {
		const normalized = normalizeToken(token);
		if (normalized && !HAN_PATTERN.test(normalized)) {
			tokens.add(normalized);
		}
	}
	return [...tokens];
}

export function buildTokenizedMemoryText(text: string, metadata: string[] = []): string {
	const source = [text, ...metadata].filter((part) => part.trim().length > 0).join("\n");
	return [source, ...tokenizeMemoryText(source)].join(" ");
}

export function buildFtsQuery(query: string): string {
	return tokenizeMemoryQuery(query)
		.map((token) => `"${token.replaceAll('"', '""')}"`)
		.join(" ");
}
