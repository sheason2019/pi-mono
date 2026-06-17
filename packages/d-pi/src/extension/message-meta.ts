export interface MessageMeta {
	createTime: string;
	sourceType: "connect" | "agent" | "source";
	agentName?: string;
	sourceName?: string;
	connectId?: string;
	auth?: {
		name: string;
		description: string;
	};
}

export interface MessageMetaOptions {
	connectId?: string;
	agentName?: string;
	sourceName?: string;
}

function formatTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function injectMeta(
	text: string,
	sourceType: "connect" | "agent" | "source",
	auth?: MessageMeta["auth"],
	options?: MessageMetaOptions,
): string {
	const meta: MessageMeta = {
		createTime: formatTime(new Date()),
		sourceType,
		...(options?.agentName && { agentName: options.agentName }),
		...(options?.sourceName && { sourceName: options.sourceName }),
		// connectId is meaningful only for connect-typed meta
		...(sourceType === "connect" && options?.connectId && { connectId: options.connectId }),
		...(auth && { auth }),
	};
	return `[meta(${JSON.stringify(meta)})]\n${text}`;
}

/** Extract and parse the [meta(...)]\n prefix from a message. */
export function extractMeta(text: string): { meta: MessageMeta; text: string } | undefined {
	if (!text.startsWith("[meta(")) return undefined;
	const endIdx = text.indexOf(")]\n");
	if (endIdx === -1) return undefined;
	try {
		const meta = JSON.parse(text.slice(6, endIdx)) as MessageMeta;
		return { meta, text: text.slice(endIdx + 3) };
	} catch {
		return undefined;
	}
}

/** Build LLM-facing content from meta (used as custom message content). */
export function buildMetaContent(meta: MessageMeta): string {
	switch (meta.sourceType) {
		case "agent":
			return `Message from agent "${meta.agentName}".`;
		case "source":
			return `Message from external source "${meta.sourceName}".`;
		case "connect":
			return "";
	}
}
