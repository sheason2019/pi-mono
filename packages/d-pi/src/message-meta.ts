export function formatDPiMetaMessage(meta: Record<string, unknown>, content: string): string {
	return `[meta(${JSON.stringify(meta)})]\n${content}`;
}
