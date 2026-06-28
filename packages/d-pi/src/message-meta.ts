import { z } from "zod";

export const dPiMessageMetaSchema = z.object({
	createTime: z.string(),
	sourceType: z.union([z.literal("agent"), z.literal("connect"), z.literal("source")]),
	agentName: z.string().optional(),
	sourceName: z.string().optional(),
	connectId: z.string().optional(),
	auth: z
		.object({
			name: z.string(),
			description: z.string(),
		})
		.optional(),
});

export type DPiMessageMeta = z.infer<typeof dPiMessageMetaSchema>;

function formatMetaTime(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatDPiMetaMessage(
	meta: Omit<DPiMessageMeta, "createTime"> & Partial<Pick<DPiMessageMeta, "createTime">>,
	content: string,
): string {
	const normalized: DPiMessageMeta = {
		createTime: meta.createTime ?? formatMetaTime(new Date()),
		sourceType: meta.sourceType,
		...(meta.agentName === undefined ? {} : { agentName: meta.agentName }),
		...(meta.sourceName === undefined ? {} : { sourceName: meta.sourceName }),
		...(meta.connectId === undefined ? {} : { connectId: meta.connectId }),
		...(meta.auth === undefined ? {} : { auth: meta.auth }),
	};
	return `[meta(${JSON.stringify(normalized)})]\n${content}`;
}

export function extractDPiMeta(content: unknown): { meta: DPiMessageMeta; text: string } | undefined {
	const textContent = dPiMetaTextContent(content);
	if (textContent === undefined) {
		return undefined;
	}
	const match = textContent.match(/^\[meta\(((?:.|\n)*?)\)\]\s*\n?((?:.|\n)*)$/);
	if (!match) {
		return undefined;
	}
	try {
		const parsed = dPiMessageMetaSchema.safeParse(JSON.parse(match[1]!));
		if (!parsed.success) {
			return undefined;
		}
		return { meta: parsed.data, text: match[2] ?? "" };
	} catch {
		return undefined;
	}
}

function dPiMetaTextContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const parts = content.map((part) =>
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
			? part.text
			: "",
	);
	const text = parts.join("");
	return text.startsWith("[meta(") ? text : undefined;
}
