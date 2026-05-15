import type { ToolResultMessage } from "@sheason/pi-ai";

export type DPiToolCallStatus = "pending" | "success" | "error" | "aborted";

export interface ToolCallStatusInput {
	pending?: boolean;
	aborted?: boolean;
	result?: ToolResultMessage<unknown>;
}

export interface ToolCallStatusView {
	label: string;
	badgeClass: string;
}

export function getToolCallStatus(input: ToolCallStatusInput): DPiToolCallStatus {
	if (input.aborted) {
		return "aborted";
	}
	if (input.result?.isError) {
		return "error";
	}
	if (input.result) {
		return "success";
	}
	return "pending";
}

export function getToolCallStatusView(status: DPiToolCallStatus): ToolCallStatusView {
	switch (status) {
		case "success":
			return {
				label: "完成",
				badgeClass:
					"inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-xs font-medium text-success",
			};
		case "error":
			return {
				label: "错误",
				badgeClass:
					"inline-flex items-center gap-1 rounded-full border border-error/25 bg-error/10 px-2 py-0.5 text-xs font-medium text-error",
			};
		case "aborted":
			return {
				label: "已中断",
				badgeClass:
					"inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning",
			};
		case "pending":
			return {
				label: "运行中",
				badgeClass:
					"inline-flex items-center gap-1 rounded-full border border-info/25 bg-info/10 px-2 py-0.5 text-xs font-medium text-info",
			};
	}
}

export function getToolCommandPreview(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	if (!isCommandToolName(toolName) || typeof args?.command !== "string") {
		return undefined;
	}
	const command = args.command.trim();
	return command.length > 0 ? command : undefined;
}

export function getToolCallOutputText(result: ToolResultMessage<unknown> | undefined): string | undefined {
	const text = result?.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	return text ? text : undefined;
}

export function formatToolCallArguments(value: Record<string, unknown> | undefined): string {
	return formatUnknown(value ?? {});
}

export function formatUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function isCommandToolName(toolName: string): boolean {
	return toolName === "bash" || toolName === "shell" || toolName === "run_command" || toolName === "command";
}
