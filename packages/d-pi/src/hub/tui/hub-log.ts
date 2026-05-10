import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKSPACE_DIR_NAME } from "../config.js";

export type HubLogLevel = "info" | "warning" | "error";
export type HubLogDetails = Record<string, string | number | boolean | null>;

export interface HubLogSink {
	info(message: string, details?: string | HubLogDetails): void;
	warning(message: string, details?: string | HubLogDetails): void;
	error(message: string, details?: string | HubLogDetails): void;
}

export interface HubLogEntry {
	timestamp: number;
	level: HubLogLevel;
	message: string;
	details?: string | HubLogDetails;
}

export interface HubLogBufferOptions {
	maxEntries?: number;
	now?: () => number;
	maxFileBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const HUB_LOG_FILE_NAME = "hub.log.jsonl";
const HUB_LOG_DIR_NAME = "logs";

const LEVEL_LABELS: Record<HubLogLevel, string> = {
	info: "信息",
	warning: "警告",
	error: "错误",
};

const LEVEL_COLORS: Record<HubLogLevel, string> = {
	info: "\u001b[36m",
	warning: "\u001b[33m",
	error: "\u001b[31m",
};

const ANSI_RESET = "\u001b[0m";

const MESSAGE_LABELS: Record<string, string> = {
	"agent error": "智能体错误",
	"assistant first delta timing": "首个助手增量耗时",
	"assistant message timing": "助手消息耗时",
	"child agent removed": "子智能体已移除",
	"child agent started": "子智能体已启动",
	"child agent stopped": "子智能体已停止",
	"compaction timing": "压缩耗时",
	"conversation started": "会话开始",
	"conversation timing summary": "会话耗时汇总",
	"crdt sync rejected": "CRDT 同步已拒绝",
	"peer connected": "Peer 已连接",
	"peer disconnected": "Peer 已断开",
	"prompt preflight timing": "提交前检查耗时",
	"queue drain submitted": "队列自动提交",
	"queue flush submitted": "队列 flush 提交",
	"retry timing": "重试耗时",
	"socket fanout timing": "Socket 推送耗时",
	"source error": "Source 错误",
	"source exited": "Source 已退出",
	"source started": "Source 已启动",
	"tool timing": "工具调用耗时",
	"turn timing": "回合耗时",
};

const DETAIL_KEY_LABELS: Record<string, string> = {
	aborted: "是否中断",
	abortDurationMs: "中断耗时",
	agentId: "智能体",
	api: "API",
	attempt: "尝试",
	code: "退出码",
	drainMode: "消费模式",
	durationMs: "耗时",
	emitMs: "推送耗时",
	error: "错误",
	eventCount: "事件数",
	eventType: "事件",
	flushMessages: "flush消息数",
	inputTokens: "输入Token",
	isError: "是否错误",
	materializeMs: "素材处理耗时",
	messages: "消息数",
	model: "模型",
	outputTokens: "输出Token",
	payloadAverageBytes: "平均载荷",
	payloadBytes: "载荷大小",
	payloadMaxBytes: "最大载荷",
	payloadTotalBytes: "总载荷",
	peerCount: "Peer数",
	peerId: "Peer",
	phase: "阶段",
	provider: "供应商",
	queueWaitMs: "队列等待",
	queuedMessages: "队列消息数",
	reason: "原因",
	restartDelayMs: "重启等待",
	retryDelayMs: "重试等待",
	runId: "运行",
	signal: "信号",
	sourceName: "Source",
	stopReason: "停止原因",
	success: "成功",
	toolArgsBytes: "参数大小",
	toolCallId: "工具调用",
	toolName: "工具",
	toolResultBytes: "结果大小",
	toolResults: "工具结果",
	totalTokens: "总Token",
	turnIndex: "回合",
	turns: "回合数",
	willRetry: "将重试",
};

const DETAIL_VALUE_LABELS: Record<string, Record<string, string>> = {
	phase: {
		assistant_first_delta: "首增量",
		assistant_message: "助手消息",
		compaction: "压缩",
		conversation: "会话",
		preflight: "提交前检查",
		queue: "队列",
		retry: "重试",
		socket: "Socket",
		tool: "工具",
		turn: "回合",
	},
};

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatHubLogEntry(entry: HubLogEntry): string {
	const d = new Date(entry.timestamp);
	const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
	const base = `${time} ${LEVEL_LABELS[entry.level]} ${formatHubLogMessage(entry.message)}`;
	const details = formatHubLogDetails(entry.details);
	return details ? `${base}: ${details}` : base;
}

export interface FormatHubLogEntryForTuiOptions {
	color?: boolean;
}

export function formatHubLogEntryForTui(entry: HubLogEntry, options: FormatHubLogEntryForTuiOptions = {}): string {
	const d = new Date(entry.timestamp);
	const plainTime = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
	const time = options.color ? `\u001b[90m${plainTime}${ANSI_RESET}` : plainTime;
	const label = LEVEL_LABELS[entry.level];
	const level = options.color ? `${LEVEL_COLORS[entry.level]}${label}${ANSI_RESET}` : label;
	const base = `${time} ${level} ${formatHubLogMessage(entry.message)}`;
	if (entry.details === undefined) {
		return base;
	}
	const details = formatHubLogDetailsMultiline(entry.details);
	return details.length > 0 ? `${base}\n${details}` : base;
}

function formatHubLogMessage(message: string): string {
	return MESSAGE_LABELS[message] ?? message;
}

function formatHubLogDetails(details: HubLogEntry["details"]): string | undefined {
	if (details === undefined) {
		return undefined;
	}
	if (typeof details === "string") {
		return details;
	}
	return Object.entries(details)
		.map(([key, value]) => `${formatHubLogDetailKey(key)}=${formatHubLogDetailValue(key, value)}`)
		.join(" ");
}

function formatHubLogDetailsMultiline(details: HubLogEntry["details"]): string {
	if (details === undefined) {
		return "";
	}
	if (typeof details === "string") {
		return `  ${details}`;
	}
	const chunks = Object.entries(details).map(
		([key, value]) => `${formatHubLogDetailKey(key)}=${formatHubLogDetailValue(key, value)}`,
	);
	const lines: string[] = [];
	for (let i = 0; i < chunks.length; i += 3) {
		lines.push(`  ${chunks.slice(i, i + 3).join("  ")}`);
	}
	return lines.join("\n");
}

function formatHubLogDetailKey(key: string): string {
	return DETAIL_KEY_LABELS[key] ?? key;
}

function formatHubLogDetailValue(key: string, value: HubLogDetails[string]): string {
	if (typeof value === "number") {
		if (key.endsWith("Ms")) {
			return `${value}ms`;
		}
		if (key.endsWith("Bytes")) {
			return `${value}B`;
		}
	}
	if (typeof value === "string") {
		return DETAIL_VALUE_LABELS[key]?.[value] ?? value;
	}
	return String(value);
}

function cloneDetails(details: HubLogEntry["details"]): HubLogEntry["details"] {
	if (details === undefined || typeof details === "string") {
		return details;
	}
	return { ...details };
}

function cloneEntry(entry: HubLogEntry): HubLogEntry {
	const cloned: HubLogEntry = {
		timestamp: entry.timestamp,
		level: entry.level,
		message: entry.message,
	};
	const details = cloneDetails(entry.details);
	if (details !== undefined) {
		cloned.details = details;
	}
	return cloned;
}

export class HubLogBuffer {
	private readonly maxEntries: number;
	private readonly now: () => number;
	private readonly entries: HubLogEntry[] = [];

	constructor(options: HubLogBufferOptions = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? (() => Date.now());
	}

	info(message: string, details?: string | HubLogDetails): void {
		this.append("info", message, details);
	}

	warning(message: string, details?: string | HubLogDetails): void {
		this.append("warning", message, details);
	}

	error(message: string, details?: string | HubLogDetails): void {
		this.append("error", message, details);
	}

	append(level: HubLogLevel, message: string, details?: string | HubLogDetails): void {
		const entry: HubLogEntry = { timestamp: this.now(), level, message };
		if (details !== undefined) {
			entry.details = cloneDetails(details);
		}
		this.appendEntry(entry);
	}

	appendEntry(entry: HubLogEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}
	}

	getEntries(): HubLogEntry[] {
		return this.entries.map((entry) => cloneEntry(entry));
	}
}

export function getHubLogLegacyFile(cwd: string): string {
	return join(cwd, WORKSPACE_DIR_NAME, HUB_LOG_FILE_NAME);
}

export function getHubLogFile(cwd: string, timestamp = Date.now(), sequence = 0): string {
	const day = formatLogDay(timestamp);
	const suffix = sequence > 0 ? `.${sequence}` : "";
	return join(getHubLogDir(cwd), `${day}${suffix}.jsonl`);
}

function getHubLogDir(cwd: string): string {
	return join(cwd, WORKSPACE_DIR_NAME, HUB_LOG_DIR_NAME);
}

export class HubLogStore {
	private constructor(
		private readonly file: string,
		private readonly buffer: HubLogBuffer,
		private readonly now: () => number,
		private readonly workspaceCwd: string | undefined = undefined,
		private readonly maxFileBytes: number = DEFAULT_MAX_FILE_BYTES,
	) {}

	static open(file: string, options: HubLogBufferOptions = {}): HubLogStore {
		const buffer = new HubLogBuffer(options);
		for (const entry of loadHubLogEntries(file)) {
			buffer.appendEntry(entry);
		}
		mkdirSync(dirname(file), { recursive: true });
		return new HubLogStore(file, buffer, options.now ?? (() => Date.now()));
	}

	static openWorkspace(cwd: string, options: HubLogBufferOptions = {}): HubLogStore {
		const buffer = new HubLogBuffer(options);
		for (const entry of loadWorkspaceHubLogEntries(cwd)) {
			buffer.appendEntry(entry);
		}
		mkdirSync(getHubLogDir(cwd), { recursive: true });
		return new HubLogStore(
			getHubLogFile(cwd, (options.now ?? (() => Date.now()))()),
			buffer,
			options.now ?? (() => Date.now()),
			cwd,
			options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		);
	}

	info(message: string, details?: string | HubLogDetails): void {
		this.append("info", message, details);
	}

	warning(message: string, details?: string | HubLogDetails): void {
		this.append("warning", message, details);
	}

	error(message: string, details?: string | HubLogDetails): void {
		this.append("error", message, details);
	}

	append(level: HubLogLevel, message: string, details?: string | HubLogDetails): void {
		const entry: HubLogEntry = { timestamp: this.now(), level, message };
		if (details !== undefined) {
			entry.details = cloneDetails(details);
		}
		this.buffer.appendEntry(entry);
		const line = `${JSON.stringify(entry)}\n`;
		appendFileSync(this.getWriteFile(entry.timestamp, Buffer.byteLength(line, "utf8")), line, "utf8");
	}

	getEntries(): HubLogEntry[] {
		return this.buffer.getEntries();
	}

	private getWriteFile(timestamp: number, appendBytes: number): string {
		if (!this.workspaceCwd) {
			return this.file;
		}
		mkdirSync(getHubLogDir(this.workspaceCwd), { recursive: true });
		let sequence = 0;
		while (true) {
			const file = getHubLogFile(this.workspaceCwd, timestamp, sequence);
			if (!existsSync(file) || statSync(file).size + appendBytes <= this.maxFileBytes) {
				return file;
			}
			sequence += 1;
		}
	}
}

function loadWorkspaceHubLogEntries(cwd: string): HubLogEntry[] {
	const entries: HubLogEntry[] = [];
	entries.push(...loadHubLogEntries(getHubLogLegacyFile(cwd)));
	for (const file of listWorkspaceLogFiles(cwd)) {
		entries.push(...loadHubLogEntries(file));
	}
	return entries.sort((a, b) => a.timestamp - b.timestamp);
}

function listWorkspaceLogFiles(cwd: string): string[] {
	const dir = getHubLogDir(cwd);
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir)
		.filter((name) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name))
		.sort()
		.map((name) => join(dir, name));
}

function formatLogDay(timestamp: number): string {
	const d = new Date(timestamp);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function loadHubLogEntries(file: string): HubLogEntry[] {
	if (!existsSync(file)) {
		return [];
	}
	const raw = readFileSync(file, "utf8");
	const entries: HubLogEntry[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as unknown;
			const entry = parseHubLogEntry(parsed);
			if (entry) {
				entries.push(entry);
			}
		} catch {
			// Ignore malformed history lines so old logs never block startup.
		}
	}
	return entries;
}

function parseHubLogEntry(value: unknown): HubLogEntry | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const candidate = value as Partial<HubLogEntry>;
	if (
		typeof candidate.timestamp !== "number" ||
		!Number.isFinite(candidate.timestamp) ||
		!isHubLogLevel(candidate.level) ||
		typeof candidate.message !== "string"
	) {
		return undefined;
	}
	const entry: HubLogEntry = {
		timestamp: candidate.timestamp,
		level: candidate.level,
		message: candidate.message,
	};
	const details = parseHubLogDetails(candidate.details);
	if (details !== undefined) {
		entry.details = details;
	}
	return entry;
}

function isHubLogLevel(value: unknown): value is HubLogLevel {
	return value === "info" || value === "warning" || value === "error";
}

function parseHubLogDetails(value: unknown): HubLogEntry["details"] {
	if (value === undefined || typeof value === "string") {
		return value;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const details: HubLogDetails = {};
	for (const [key, detailValue] of Object.entries(value)) {
		if (
			typeof detailValue === "string" ||
			typeof detailValue === "number" ||
			typeof detailValue === "boolean" ||
			detailValue === null
		) {
			details[key] = detailValue;
		}
	}
	return details;
}
