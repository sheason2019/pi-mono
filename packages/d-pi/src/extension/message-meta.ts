export interface MessageMeta {
	createTime: string;
	sourceType: "connect" | "agent";
	agentId?: string;
	tips: string;
}

const TIPS: Record<string, string> = {
	connect: "Message from Connect TUI, your output is visible to the user.",
	agent: "Message from another agent. Use send_message to reply.",
};

function formatTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function injectMeta(text: string, sourceType: "connect" | "agent", agentId?: string): string {
	const meta: MessageMeta = {
		createTime: formatTime(new Date()),
		sourceType,
		...(agentId && { agentId }),
		tips: TIPS[sourceType],
	};
	return `[meta(${JSON.stringify(meta)})]\n${text}`;
}
