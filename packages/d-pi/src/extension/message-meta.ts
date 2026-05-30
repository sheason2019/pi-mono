export interface MessageMeta {
	createTime: string;
	sourceType: "connect" | "agent" | "source";
	agentId?: string;
	sourceName?: string;
	tips: string;
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
	agentId?: string,
	sourceName?: string,
): string {
	const meta: MessageMeta = {
		createTime: formatTime(new Date()),
		sourceType,
		...(agentId && { agentId }),
		...(sourceName && { sourceName }),
		tips: TIPS[sourceType],
	};
	return `[meta(${JSON.stringify(meta)})]\n${text}`;
}
