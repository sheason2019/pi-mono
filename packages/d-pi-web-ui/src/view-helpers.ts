import type { HubViewDocumentState } from "./d-pi-hub.js";

export interface DisplayMessageSource {
	kind: string;
	name: string;
}

export type ComposerActionKind = "send" | "interrupt";
export type ComposerActionIcon = "send" | "stop";

export interface ComposerActionView {
	kind: ComposerActionKind;
	ariaLabel: string;
	title: string;
	buttonClass: string;
	icon: ComposerActionIcon;
	disabled: boolean;
	hint: string;
}

export function getSelectableAgentIds(view: HubViewDocumentState, selectedAgentId: string): string[] {
	const agentsById = view.agentsById ?? {};
	const ordered = (view.agentOrder ?? []).filter((agentId) => Boolean(agentsById[agentId]));
	if (!ordered.includes(selectedAgentId)) {
		ordered.push(selectedAgentId);
	}
	return ordered.length > 0 ? ordered : ["root"];
}

export function getHeaderAgentId(selectedAgentId: string, _snapshotAgentId: string): string {
	return selectedAgentId;
}

export function getSelectedAgentIsRunning(view: HubViewDocumentState, selectedAgentId: string): boolean {
	return view.agentsById?.[selectedAgentId]?.status.isRunning === true;
}

export function getComposerActionView(input: {
	isConnected: boolean;
	isRunning: boolean;
	inputValue: string;
}): ComposerActionView {
	if (input.isRunning) {
		return {
			kind: "interrupt",
			ariaLabel: "中断回复",
			title: "中断回复",
			buttonClass: "btn btn-error btn-circle btn-sm",
			icon: "stop",
			disabled: !input.isConnected,
			hint: "正在回复，点击停止可中断。",
		};
	}
	return {
		kind: "send",
		ariaLabel: "发送消息",
		title: "发送消息",
		buttonClass: "btn btn-primary btn-circle btn-sm",
		icon: "send",
		disabled: !input.isConnected || !input.inputValue.trim(),
		hint: "Enter 发送，Shift+Enter 换行。",
	};
}

export function createAgentPath(agentId: string): string {
	if (agentId === "root" || agentId === "main") {
		return "/agents/root";
	}
	return `/agents/${encodeURIComponent(agentId)}`;
}

export function formatMessageSourceLabel(source: DisplayMessageSource | undefined): string | undefined {
	if (!source) {
		return undefined;
	}
	return `${source.kind}/${source.name}`;
}

export function formatMessageSourceTooltip(label: string | undefined): string | undefined {
	return label ? `该消息发送自节点 ${label}` : undefined;
}

export function getMessageSource(value: unknown): DisplayMessageSource | undefined {
	if (!value || typeof value !== "object" || !("messageSource" in value)) {
		return undefined;
	}
	const source = (value as { messageSource?: unknown }).messageSource;
	if (!source || typeof source !== "object" || !("kind" in source) || !("name" in source)) {
		return undefined;
	}
	const { kind, name } = source as { kind?: unknown; name?: unknown };
	return typeof kind === "string" && typeof name === "string" ? { kind, name } : undefined;
}
