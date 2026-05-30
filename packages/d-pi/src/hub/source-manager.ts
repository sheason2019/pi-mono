import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { SourceConfig, SourceInfo, SourceStatus } from "../types.ts";

interface SourceRecord {
	name: string;
	command: string;
	args: string[];
	cwd: string | undefined;
	env: Record<string, string> | undefined;
	status: SourceStatus;
	process: ChildProcess | undefined;
	subscribers: Set<string>;
	creatorAgentId: string | undefined;
	restartCount: number;
	restartTimer: ReturnType<typeof setTimeout> | undefined;
	destroyed: boolean;
}

const MAX_RESTART_DELAY_MS = 60_000;
const INITIAL_RESTART_DELAY_MS = 1_000;

export class SourceManager {
	private readonly _sources = new Map<string, SourceRecord>();
	private readonly _onBroadcast: (sourceName: string, line: string, subscriberAgentIds: string[]) => void;

	constructor(onBroadcast: SourceManager["_onBroadcast"]) {
		this._onBroadcast = onBroadcast;
	}

	createSource(config: SourceConfig, creatorAgentId?: string): void {
		if (this._sources.has(config.name)) {
			throw new Error(`Source "${config.name}" already exists`);
		}

		const record: SourceRecord = {
			name: config.name,
			command: config.command,
			args: config.args ?? [],
			cwd: config.cwd,
			env: config.env,
			status: "running",
			process: undefined,
			subscribers: new Set(),
			creatorAgentId,
			restartCount: 0,
			restartTimer: undefined,
			destroyed: false,
		};

		// Auto-subscribe the creator agent
		if (creatorAgentId) {
			record.subscribers.add(creatorAgentId);
		}

		this._sources.set(config.name, record);
		this._spawnProcess(record);
	}

	destroySource(name: string): void {
		const record = this._sources.get(name);
		if (!record) {
			throw new Error(`Source "${name}" not found`);
		}
		if (record.subscribers.size > 0) {
			const subscriberList = Array.from(record.subscribers).join(", ");
			throw new Error(
				`Cannot destroy source "${name}": ${record.subscribers.size} subscriber(s) still active (${subscriberList}). Unsubscribe all agents first.`,
			);
		}
		this._destroyRecord(record);
	}

	subscribe(sourceName: string, agentId: string): void {
		const record = this._sources.get(sourceName);
		if (!record) {
			throw new Error(`Source "${sourceName}" not found`);
		}
		record.subscribers.add(agentId);
	}

	unsubscribe(sourceName: string, agentId: string): void {
		const record = this._sources.get(sourceName);
		if (!record) {
			throw new Error(`Source "${sourceName}" not found`);
		}
		record.subscribers.delete(agentId);
	}

	listSources(): SourceInfo[] {
		return Array.from(this._sources.values()).map((r) => ({
			name: r.name,
			command: r.command,
			args: r.args,
			status: r.status,
			subscriberCount: r.subscribers.size,
		}));
	}

	removeAgentSubscriptions(agentId: string): void {
		for (const record of this._sources.values()) {
			record.subscribers.delete(agentId);
		}
	}

	/** Return names of sources whose creator is the given agent */
	getSourcesByCreator(agentId: string): string[] {
		const result: string[] = [];
		for (const record of this._sources.values()) {
			if (record.creatorAgentId === agentId) {
				result.push(record.name);
			}
		}
		return result;
	}

	/** Return names of sources the given agent is subscribed to */
	getAgentSubscriptions(agentId: string): string[] {
		const result: string[] = [];
		for (const record of this._sources.values()) {
			if (record.subscribers.has(agentId)) {
				result.push(record.name);
			}
		}
		return result;
	}

	stopAll(): void {
		for (const record of this._sources.values()) {
			this._destroyRecord(record);
		}
		this._sources.clear();
	}

	private _spawnProcess(record: SourceRecord): void {
		const child = spawn(record.command, record.args, {
			cwd: record.cwd,
			env: record.env ? { ...process.env, ...record.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: true,
		});

		record.process = child;
		record.status = "running";

		const stdoutReader = createInterface({ input: child.stdout! });
		stdoutReader.on("line", (line) => {
			this._onLine(record.name, line);
		});

		const stderrReader = createInterface({ input: child.stderr! });
		stderrReader.on("line", (line) => {
			this._onLine(record.name, `[stderr] ${line}`);
		});

		child.on("error", (err) => {
			process.stderr.write(`[d-pi source] Source "${record.name}" process error: ${err.message}\n`);
			record.status = "error";
			record.process = undefined;
			this._notifyCreator(
				record,
				`Source "${record.name}" encountered a process error: ${err.message}. Restarting with exponential backoff.`,
			);
			this._scheduleRestart(record);
		});

		child.on("exit", (code, signal) => {
			process.stderr.write(`[d-pi source] Source "${record.name}" exited with code=${code} signal=${signal}\n`);
			record.process = undefined;
			if (record.destroyed) return;
			record.status = "stopped";
			this._notifyCreator(
				record,
				`Source "${record.name}" exited unexpectedly (code=${code}, signal=${signal}). Restarting with exponential backoff.`,
			);
			this._scheduleRestart(record);
		});
	}

	private _scheduleRestart(record: SourceRecord): void {
		if (record.destroyed) return;
		if (record.restartTimer) return; // Already scheduled

		const delay = Math.min(INITIAL_RESTART_DELAY_MS * 2 ** record.restartCount, MAX_RESTART_DELAY_MS);
		record.restartCount++;

		process.stderr.write(
			`[d-pi source] Source "${record.name}" restarting in ${delay}ms (attempt ${record.restartCount})\n`,
		);

		record.restartTimer = setTimeout(() => {
			record.restartTimer = undefined;
			if (record.destroyed) return;
			process.stderr.write(`[d-pi source] Source "${record.name}" restarting now\n`);
			this._spawnProcess(record);
		}, delay);
	}

	private _onLine(sourceName: string, line: string): void {
		const record = this._sources.get(sourceName);
		if (!record || record.subscribers.size === 0) return;

		const subscriberIds = Array.from(record.subscribers);
		this._onBroadcast(sourceName, line, subscriberIds);
	}

	private _notifyCreator(record: SourceRecord, message: string): void {
		if (!record.creatorAgentId) return;
		this._onBroadcast(record.name, `[source-error] ${message}`, [record.creatorAgentId]);
	}

	private _destroyRecord(record: SourceRecord): void {
		record.destroyed = true;
		if (record.restartTimer) {
			clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
		}
		this._killProcess(record);
		this._sources.delete(record.name);
	}

	private _killProcess(record: SourceRecord): void {
		if (record.process && !record.process.killed) {
			record.process.kill("SIGTERM");
			setTimeout(() => {
				if (record.process && !record.process.killed) {
					record.process.kill("SIGKILL");
				}
			}, 3000);
		}
		record.status = "stopped";
		record.process = undefined;
	}
}
