import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { MAIN_AGENT_ID } from "../agents/types.js";
import { markDetachedChildProcess, terminateChildProcessTree } from "../processes/child-process-tree.js";
import type { HubLogDetails, HubLogSink } from "../tui/hub-log.js";
import { loadSourcesConfig } from "./source-config.js";
import {
	pauseSourceInConfig,
	pauseSourceInConfigFile,
	removeSourceInConfig,
	removeSourceInConfigFile,
	resumeSourceInConfig,
	resumeSourceInConfigFile,
} from "./source-config-writer.js";
import type { SourceConfig, SourceRuntimeStatus } from "./source-types.js";

export type SpawnStdioSource = (options: {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}) => ChildProcess;

/** Bridges parsed source stdout into the hub agent session (after Task 5). */
export interface SourceHostInboundBridge {
	submitFromSource: (sourceName: string, agentId: string, text: string) => Promise<void>;
}

export interface SourceConfigMutationTarget {
	resourceId: string;
	configResourceId: string;
	configPath?: string;
	name: string;
	agentId: string;
}

export interface SourceHostOptions {
	cwd: string;
	spawnStdio?: SpawnStdioSource;
	inbound?: SourceHostInboundBridge;
	loadSources?: () => SourceConfig[];
	logs?: HubLogSink;
	sourceMutators?: {
		pause: (resourceId: string, target?: SourceConfigMutationTarget) => void;
		resume: (resourceId: string, target?: SourceConfigMutationTarget) => void;
		remove: (resourceId: string, target?: SourceConfigMutationTarget) => void;
	};
}

function defaultSpawnStdio(options: {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}): ChildProcess {
	const detached = process.platform !== "win32";
	const child = nodeSpawn(options.command, options.args, {
		cwd: options.cwd,
		detached,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	return detached ? markDetachedChildProcess(child) : child;
}

function mergeEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
	if (!extra) {
		return { ...base };
	}
	return { ...base, ...extra };
}

function formatExitError(code: number | null, signal: NodeJS.Signals | null, stderrText: string): string {
	const parts: string[] = [];
	if (signal) {
		parts.push(`exited on signal ${signal}`);
	} else if (code !== null && code !== 0) {
		parts.push(`exited with code ${code}`);
	} else {
		parts.push("exited unexpectedly");
	}
	const tail = stderrText.trim();
	if (tail.length > 0) {
		parts.push(`stderr: ${tail}`);
	}
	return parts.join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawSourceResourceId(resourceId: string): string {
	const idx = resourceId.indexOf(":");
	return idx >= 0 ? resourceId.slice(idx + 1) : resourceId;
}

function sourceResourceIdsMatch(a: string, b: string): boolean {
	return a === b || rawSourceResourceId(a) === rawSourceResourceId(b);
}

function parseQueueWriteNotificationLine(line: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Invalid JSON: ${msg}`);
	}
	if (!isRecord(parsed)) {
		throw new Error("JSON-RPC payload must be a JSON object");
	}
	if ("id" in parsed) {
		throw new Error('JSON-RPC source lines must be notifications (omit "id")');
	}
	if (parsed.jsonrpc !== "2.0") {
		throw new Error('JSON-RPC payload must have jsonrpc "2.0"');
	}
	if (parsed.method !== "queue/write") {
		throw new Error(`Unsupported JSON-RPC method: ${String(parsed.method)}`);
	}
	const params = parsed.params;
	if (!isRecord(params)) {
		throw new Error("JSON-RPC queue/write notification requires a params object");
	}
	const content = params.content;
	if (typeof content !== "string") {
		throw new Error("JSON-RPC queue/write params.content must be a string");
	}
	if ("delivery" in params) {
		throw new Error("JSON-RPC queue/write does not support params.delivery; all source messages are queued");
	}
	return content;
}

export class SourceHost {
	private readonly cwd: string;
	private readonly spawnStdio: SpawnStdioSource;
	private readonly inbound: SourceHostInboundBridge | undefined;
	private readonly loadSources: () => SourceConfig[];
	private readonly logs: HubLogSink | undefined;
	private readonly sourceMutators: NonNullable<SourceHostOptions["sourceMutators"]>;
	private readonly statuses = new Map<string, SourceRuntimeStatus>();
	private readonly children = new Map<string, ChildProcess>();
	private readonly stdoutUtf8Decoders = new Map<string, StringDecoder>();
	private readonly stdoutLineBuffers = new Map<string, string>();
	private readonly stdoutLineChains = new Map<string, Promise<void>>();
	private readonly sourceMetaByResourceId = new Map<string, SourceConfigMutationTarget>();
	private stopping = false;

	constructor(options: SourceHostOptions) {
		this.cwd = options.cwd;
		this.spawnStdio = options.spawnStdio ?? defaultSpawnStdio;
		this.inbound = options.inbound;
		this.loadSources = options.loadSources ?? (() => loadSourcesConfig(this.cwd));
		this.logs = options.logs;
		this.sourceMutators = options.sourceMutators ?? {
			pause: (resourceId, target) =>
				target?.configPath
					? pauseSourceInConfigFile(target.configPath, target.configResourceId)
					: pauseSourceInConfig(this.cwd, resourceId),
			resume: (resourceId, target) =>
				target?.configPath
					? resumeSourceInConfigFile(target.configPath, target.configResourceId)
					: resumeSourceInConfig(this.cwd, resourceId),
			remove: (resourceId, target) =>
				target?.configPath
					? removeSourceInConfigFile(target.configPath, target.configResourceId)
					: removeSourceInConfig(this.cwd, resourceId),
		};
	}

	getStatuses(): SourceRuntimeStatus[] {
		return [...this.statuses.values()];
	}

	private setStatus(resourceId: string, status: SourceRuntimeStatus["status"], error?: string): void {
		const meta = this.sourceMetaByResourceId.get(resourceId);
		const name = meta?.name ?? resourceId;
		const agentId = meta?.agentId ?? MAIN_AGENT_ID;
		const next: SourceRuntimeStatus = { resourceId, name, transport: "stdio", agentId, origin: "hub", status };
		if (error !== undefined) {
			next.error = error;
		}
		this.statuses.set(resourceId, next);
	}

	private log(level: keyof HubLogSink, message: string, details?: string | HubLogDetails): void {
		try {
			this.logs?.[level](message, details);
		} catch {
			// Logging must not interfere with source delivery.
		}
	}

	private attachChildDiagnostics(child: ChildProcess, resourceId: string): { getStderrText: () => string } {
		const stderrChunks: Buffer[] = [];
		child.stderr?.on("data", (chunk: string | Buffer) => {
			stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stdout?.on("data", (chunk: string | Buffer) => {
			if (!this.inbound) {
				return;
			}
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			this.appendStdoutLines(resourceId, buf);
		});
		return {
			getStderrText: () => Buffer.concat(stderrChunks).toString("utf8"),
		};
	}

	private appendStdoutLines(resourceId: string, chunk: Buffer): void {
		let decoder = this.stdoutUtf8Decoders.get(resourceId);
		if (!decoder) {
			decoder = new StringDecoder("utf8");
			this.stdoutUtf8Decoders.set(resourceId, decoder);
		}
		const prev = this.stdoutLineBuffers.get(resourceId) ?? "";
		const combined = prev + decoder.write(chunk);
		const lines = combined.split("\n");
		const tail = lines.pop() ?? "";
		this.stdoutLineBuffers.set(resourceId, tail);
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			this.enqueueStdoutLine(resourceId, trimmed);
		}
	}

	private enqueueStdoutLine(resourceId: string, line: string): void {
		if (!this.inbound) {
			return;
		}
		const bridge = this.inbound;
		const prev = this.stdoutLineChains.get(resourceId) ?? Promise.resolve();
		const next = prev.then(() => this.processStdoutLine(resourceId, line, bridge));
		this.stdoutLineChains.set(resourceId, next);
	}

	private async processStdoutLine(resourceId: string, line: string, bridge: SourceHostInboundBridge): Promise<void> {
		try {
			const meta = this.sourceMetaByResourceId.get(resourceId);
			const sourceName = meta?.name ?? resourceId;
			const agentId = meta?.agentId ?? MAIN_AGENT_ID;
			let text: string;
			try {
				text = parseQueueWriteNotificationLine(line);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.setStatus(resourceId, "error", msg);
				return;
			}
			await bridge.submitFromSource(sourceName, agentId, text);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setStatus(resourceId, "error", msg);
		}
	}

	private startOne(config: SourceConfig): void {
		const effectiveAgentId = config.agentId ?? MAIN_AGENT_ID;
		const resourceId = config.resourceId;
		this.sourceMetaByResourceId.set(resourceId, {
			name: config.name,
			agentId: effectiveAgentId,
			resourceId,
			configResourceId: config.configResourceId ?? rawSourceResourceId(resourceId),
			configPath: config.configPath,
		});
		if (config.disabled === true) {
			this.setStatus(resourceId, "stopped");
			return;
		}
		this.setStatus(resourceId, "starting");
		let child: ChildProcess;
		try {
			child = this.spawnStdio({
				command: config.command,
				args: config.args ?? [],
				cwd: config.cwd ?? this.cwd,
				env: mergeEnv(process.env, config.env),
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.setStatus(resourceId, "error", msg);
			this.log("error", "source error", { sourceName: config.name, agentId: effectiveAgentId, error: msg });
			return;
		}

		this.children.set(resourceId, child);
		const { getStderrText } = this.attachChildDiagnostics(child, resourceId);

		child.once("error", (err) => {
			if (this.children.get(resourceId) !== child) {
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			this.setStatus(resourceId, "error", msg);
			this.log("error", "source error", { sourceName: config.name, agentId: effectiveAgentId, error: msg });
		});

		child.once("spawn", () => {
			if (this.children.get(resourceId) !== child) {
				return;
			}
			if (this.stopping) {
				return;
			}
			if (this.statuses.get(resourceId)?.status === "error") {
				return;
			}
			this.setStatus(resourceId, "running");
			this.log("info", "source started", { sourceName: config.name, agentId: effectiveAgentId });
		});

		child.once("exit", (code, signal) => {
			if (this.children.get(resourceId) !== child) {
				return;
			}
			this.children.delete(resourceId);
			if (this.stopping) {
				return;
			}
			if (code === 0 && !signal) {
				this.setStatus(resourceId, "stopped");
				this.log("warning", "source exited", {
					sourceName: config.name,
					code: code ?? null,
					signal: signal ?? null,
				});
				return;
			}
			const error = formatExitError(code, signal, getStderrText());
			this.setStatus(resourceId, "error", error);
			this.log("error", "source error", {
				sourceName: config.name,
				code: code ?? null,
				signal: signal ?? null,
				error,
			});
		});
	}

	async start(): Promise<void> {
		this.stopping = false;
		this.statuses.clear();
		this.stdoutUtf8Decoders.clear();
		this.stdoutLineBuffers.clear();
		this.stdoutLineChains.clear();
		this.sourceMetaByResourceId.clear();
		for (const child of this.children.values()) {
			terminateChildProcessTree(child);
		}
		this.children.clear();

		const configs = this.loadSources();
		for (const c of configs) {
			this.startOne(c);
		}
	}

	private killChild(resourceId: string): void {
		const child = this.children.get(resourceId);
		this.children.delete(resourceId);
		this.stdoutUtf8Decoders.delete(resourceId);
		this.stdoutLineBuffers.delete(resourceId);
		this.stdoutLineChains.delete(resourceId);
		if (child) {
			terminateChildProcessTree(child);
		}
	}

	private requireKnownResourceId(resourceId: string): void {
		if (!this.statuses.has(resourceId)) {
			throw new Error(`Source resourceId ${JSON.stringify(resourceId)} not found`);
		}
	}

	private requireMatchingResourceIds(resourceId: string): string[] {
		const matches = [...this.statuses.keys()].filter((candidate) => sourceResourceIdsMatch(candidate, resourceId));
		if (matches.length === 0) {
			throw new Error(`Source resourceId ${JSON.stringify(resourceId)} not found`);
		}
		return matches;
	}

	private mutateMatchingConfigEntries(
		resourceIds: string[],
		mutate: (resourceId: string, target: SourceConfigMutationTarget | undefined) => void,
	): void {
		const seen = new Set<string>();
		for (const resourceId of resourceIds) {
			const target = this.sourceMetaByResourceId.get(resourceId);
			const key = `${target?.configPath ?? ""}\0${target?.configResourceId ?? resourceId}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			mutate(resourceId, target);
		}
	}

	async pauseSource(resourceId: string): Promise<void> {
		const matches = this.requireMatchingResourceIds(resourceId);
		this.mutateMatchingConfigEntries(matches, (id, target) => this.sourceMutators.pause(id, target));
		for (const id of matches) {
			this.killChild(id);
			this.setStatus(id, "stopped");
		}
	}

	async restartSource(resourceId: string): Promise<void> {
		const matches = this.requireMatchingResourceIds(resourceId);
		this.mutateMatchingConfigEntries(matches, (id, target) => this.sourceMutators.resume(id, target));
		for (const id of matches) {
			this.killChild(id);
		}
		const configs = this.loadSources();
		const matchedConfigs = configs.filter((c) => sourceResourceIdsMatch(c.resourceId, resourceId));
		if (matchedConfigs.length === 0) {
			throw new Error(`Source resourceId ${JSON.stringify(resourceId)} not found`);
		}
		for (const cfg of matchedConfigs) {
			this.startOne(cfg);
		}
	}

	async removeSource(resourceId: string): Promise<void> {
		this.requireKnownResourceId(resourceId);
		this.sourceMutators.remove(resourceId);
		this.killChild(resourceId);
		this.sourceMetaByResourceId.delete(resourceId);
		this.statuses.delete(resourceId);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const [resourceId, child] of this.children) {
			terminateChildProcessTree(child);
			this.children.delete(resourceId);
			this.setStatus(resourceId, "stopped");
		}
	}
}
