export interface MessageMeta {
	createTime: string;
	sourceType: "connect" | "agent" | "source";
	agentId?: string;
	sourceName?: string;
	connectId?: string;
	auth?: {
		name: string;
		description: string;
	};
	tips: string;
}

export interface MessageMetaOptions {
	connectId?: string;
	agentId?: string;
	sourceName?: string;
}

const TIPS: Record<string, string> = {
	connect: "Message from Connect TUI, your output is visible to the user.",
	agent: "Message from another agent. Use send_message to reply.",
	source: "Message from an external source. Use unsubscribe_source to stop receiving.",
};

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
		...(options?.agentId && { agentId: options.agentId }),
		...(options?.sourceName && { sourceName: options.sourceName }),
		// connectId is meaningful only for connect-typed meta
		...(sourceType === "connect" && options?.connectId && { connectId: options.connectId }),
		...(auth && { auth }),
		tips: TIPS[sourceType],
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
			return `Message from agent "${meta.agentId}". ${meta.tips}`;
		case "source":
			return `Message from external source "${meta.sourceName}". ${meta.tips}`;
		case "connect":
			// Intentionally omit connectId: it's a routing/display identifier, not
			// useful context for the LLM. The generic tips already explain the
			// "connect" channel. Including the id here would leak implementation
			// detail into the model prompt.
			return meta.tips;
	}
}
