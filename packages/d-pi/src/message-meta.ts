export interface DPiMessageMeta {
	createTime: string;
	sourceType: "agent" | "connect" | "source";
	agentName?: string;
	sourceName?: string;
	connectId?: string;
	auth?: {
		name: string;
		description: string;
	};
}

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
		const parsed = JSON.parse(match[1]!);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		if (parsed.sourceType !== "agent" && parsed.sourceType !== "connect" && parsed.sourceType !== "source") {
			return undefined;
		}
		return { meta: parsed as DPiMessageMeta, text: match[2] ?? "" };
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

export function buildDPiMetaContent(meta: DPiMessageMeta): string {
	switch (meta.sourceType) {
		case "agent":
			return `Message from agent "${meta.agentName ?? "unknown"}".`;
		case "source":
			return `Message from external source "${meta.sourceName ?? "unknown"}".`;
		case "connect":
			return "Message from Connect TUI.";
	}
}
