import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatHubLogEntryForTui, type HubLogEntry } from "./hub-log.js";

export interface HubTuiAgentView {
	id: string;
	name?: string;
	description?: string;
	kind: "root" | "child" | "guest";
	isRunning: boolean;
	hydrationStatus?: "running" | "loading" | "not_hydrated" | "error";
	peerCount: number;
	sessionFile: string;
	lastError?: string;
	lastRunDurationMs?: number;
}

export interface HubTuiStatusCounts {
	starting: number;
	running: number;
	stopped: number;
	error: number;
}

export interface HubTuiResourceView {
	mcpServers: number;
	mcpStatusCounts?: HubTuiStatusCounts;
	sources: number;
	sourceStatusCounts?: HubTuiStatusCounts;
	skills: number;
	prompts: number;
	themes: number;
}

export interface HubTuiViewModel {
	status: "starting" | "running" | "stopping" | "error";
	address?: string;
	workspace: string;
	rootToken?: string;
	hubVersion?: string;
	protocolVersion: number;
	agents: HubTuiAgentView[];
	resources: HubTuiResourceView;
	logs: HubLogEntry[];
}

function statusLabel(status: HubTuiViewModel["status"]): string {
	switch (status) {
		case "starting":
			return "启动中";
		case "running":
			return "运行中";
		case "stopping":
			return "停止中";
		case "error":
			return "异常";
	}
}

function agentStateLabel(agent: HubTuiAgentView): string {
	if (agent.hydrationStatus === "loading") return "加载中";
	if (agent.hydrationStatus === "not_hydrated") return "未加载";
	if (agent.hydrationStatus === "error") return "错误";
	return agent.isRunning ? "运行中" : "空闲";
}

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
		return "--:--";
	}
	const totalSeconds = Math.floor(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function relativeSessionFile(workspace: string, sessionFile: string): string {
	const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
	if (sessionFile.startsWith(prefix)) {
		return sessionFile.slice(prefix.length);
	}
	return sessionFile;
}

function buildHubStatusLines(view: HubTuiViewModel, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const address = view.address ?? "(未监听)";
	const versionSuffix = view.hubVersion ? ` v${view.hubVersion}` : "";
	const lines = [
		joinLeftRight(
			`pi-hub${versionSuffix} ${statusLabel(view.status)}  ${address}`,
			`protocol ${view.protocolVersion}`,
			safeWidth,
		),
		truncateLine(`workspace  ${view.workspace}`, safeWidth),
		"",
		...renderAccessSection(view, safeWidth),
		divider(safeWidth),
		...renderAgentsSection(view, safeWidth),
		"",
		...renderResourcesSection(view, safeWidth),
		"",
		...renderRecentEventsSection(view, safeWidth),
		"",
		truncateLine("Keys  l 日志   q 退出   Ctrl+C 退出", safeWidth),
	];
	return lines;
}

function renderAccessSection(view: HubTuiViewModel, width: number): string[] {
	return [truncateLine("Access", width), truncateLine(`  Root token  ${view.rootToken ?? "(unavailable)"}`, width)];
}

function renderAgentsSection(view: HubTuiViewModel, width: number): string[] {
	const running = view.agents.filter((agent) => agent.isRunning).length;
	const idle = Math.max(0, view.agents.length - running);
	const lines = [truncateLine(`Agents  ${view.agents.length} total  ${running} running  ${idle} idle`, width)];
	if (view.agents.length === 0) {
		lines.push(truncateLine("  (暂无 agent)", width));
		return lines;
	}
	for (const agent of view.agents) {
		const indicator = agent.lastError ? "!" : agent.isRunning ? "●" : "○";
		const label = agent.name ?? agent.id;
		const sessionFile = relativeSessionFile(view.workspace, agent.sessionFile);
		const details = [
			`${indicator} ${padEndVisible(agent.id, 10)}`,
			padEndVisible(agentStateLabel(agent), 6),
			`peers ${agent.peerCount}`,
			`last ${formatDuration(agent.lastRunDurationMs)}`,
			label,
		].join("  ");
		lines.push(truncateLine(details, width));
		lines.push(
			truncateLine(
				`             session ${sessionFile}${agent.lastError ? `  错误 ${agent.lastError}` : ""}`,
				width,
			),
		);
		if (agent.description) {
			lines.push(truncateLine(`             ${agent.description}`, width));
		}
	}
	return lines;
}

function renderResourcesSection(view: HubTuiViewModel, width: number): string[] {
	return [
		truncateLine("Resources", width),
		truncateLine(formatRuntimeResourceLine("MCP", view.resources.mcpServers, view.resources.mcpStatusCounts), width),
		truncateLine(
			formatRuntimeResourceLine("Sources", view.resources.sources, view.resources.sourceStatusCounts),
			width,
		),
		truncateLine(
			`Skills   ${view.resources.skills}       Prompts ${view.resources.prompts}       Themes ${view.resources.themes}`,
			width,
		),
	];
}

function renderRecentEventsSection(view: HubTuiViewModel, width: number): string[] {
	const recentEvents = view.logs.filter((entry) => entry.level === "warning" || entry.level === "error").slice(-5);
	const lines = [truncateLine("Recent Events", width)];
	if (recentEvents.length === 0) {
		lines.push(truncateLine("  (暂无警告/错误)", width));
		return lines;
	}
	for (const entry of recentEvents) {
		lines.push(truncateLine(formatHubLogEntryForTui(entry).replace(/\n\s*/g, "  "), width));
	}
	return lines;
}

function formatRuntimeResourceLine(label: string, total: number, counts: HubTuiStatusCounts | undefined): string {
	const parts = [padEndVisible(label, 7), `${total} total`];
	if (counts) {
		for (const [key, count] of [
			["running", counts.running],
			["starting", counts.starting],
			["stopped", counts.stopped],
			["error", counts.error],
		] as const) {
			if (count > 0) {
				parts.push(`${count} ${key}`);
			}
		}
	}
	return parts.join("  ");
}

function divider(width: number): string {
	return "─".repeat(Math.max(1, width));
}

function truncateLine(line: string, width: number): string {
	return truncateToWidth(line, width, "");
}

function joinLeftRight(left: string, right: string, width: number): string {
	const safeLeft = truncateToWidth(left, width, "");
	const leftWidth = visibleWidth(safeLeft);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return `${safeLeft}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	const availableForRight = Math.max(0, width - leftWidth - 2);
	if (availableForRight === 0) {
		return safeLeft;
	}
	return `${safeLeft}  ${truncateToWidth(right, availableForRight, "")}`;
}

function padEndVisible(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current >= width) {
		return text;
	}
	return `${text}${" ".repeat(width - current)}`;
}

export interface RenderHubTuiLinesOptions {
	mode?: "status" | "logs";
	logScrollOffsetFromBottom?: number;
	color?: boolean;
}

export function renderHubLogLines(
	view: HubTuiViewModel,
	options: Pick<RenderHubTuiLinesOptions, "color"> = {},
): string[] {
	if (view.logs.length === 0) {
		return ["(暂无日志)"];
	}
	return view.logs.flatMap((entry) => formatHubLogEntryForTui(entry, { color: options.color }).split("\n"));
}

export function renderHubTuiLines(
	view: HubTuiViewModel,
	width: number,
	height?: number,
	options: RenderHubTuiLinesOptions = {},
): string[] {
	const statusLines = buildHubStatusLines(view, width);
	if (options.mode !== "logs") {
		return Number.isFinite(height ?? Number.POSITIVE_INFINITY)
			? statusLines.slice(0, height ?? statusLines.length)
			: statusLines;
	}
	const divider = "─".repeat(Math.max(1, width));
	const maxLines = height ?? Number.POSITIVE_INFINITY;
	const headerLines = [
		`日志                         ${view.address ?? "(未监听)"}`,
		"快捷键: q 返回  ↑/↓ 滚动  PgUp/PgDn 翻页  End 到底",
	];
	const footerLines = [divider, ...statusLines.slice(0, 2)];
	const logLines = renderHubLogLines(view, { color: options.color });
	const logCapacity = Math.max(0, maxLines - headerLines.length - footerLines.length);
	const maxScrollOffset = Math.max(0, logLines.length - logCapacity);
	const scrollOffset = Math.min(Math.max(0, options.logScrollOffsetFromBottom ?? 0), maxScrollOffset);
	const end = Math.max(0, logLines.length - scrollOffset);
	const start = Math.max(0, end - logCapacity);
	const visibleLogs = logLines.slice(start, end);
	const lines = [...headerLines, ...visibleLogs, ...footerLines];
	return Number.isFinite(maxLines) ? lines.slice(Math.max(0, lines.length - maxLines)) : lines;
}
