export function formatDPiMetaMessage(meta: Record<string, unknown>, content: string): string {
	return `[meta(${JSON.stringify(meta)})]\n${content}`;
}

export function extractDPiMeta(content: unknown): { meta: Record<string, unknown>; text: string } | undefined {
	if (typeof content !== "string") {
		return undefined;
	}
	const match = content.match(/^\[meta\(((?:.|\n)*?)\)\]\s*\n?((?:.|\n)*)$/);
	if (!match) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(match[1]!);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		return { meta: parsed as Record<string, unknown>, text: match[2] ?? "" };
	} catch {
		return undefined;
	}
}
