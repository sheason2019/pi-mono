import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { SourceConfig, SourceInfo, SourceStatus } from "../types.ts";
import { validateLine } from "./source-validator.ts";

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
	stdoutReader: ReadlineInterface | undefined;
	stderrReader: ReadlineInterface | undefined;
}

const MAX_RESTART_DELAY_MS = 60_000;
const INITIAL_RESTART_DELAY_MS = 10_000;
const MAX_RESTART_ATTEMPTS = 5;

export interface SourceManagerOptions {
	/** Initial backoff between restart attempts. Default 10s. */
	initialRestartDelayMs?: number;
	/** Cap on the exponential backoff. Default 60s. */
	maxRestartDelayMs?: number;
	/** Number of consecutive restart attempts before the source is marked failed. Default 5. */
	maxRestartAttempts?: number;
}

/**
 * Source-message routing mode. Sources declare a per-event `params.mode`
 * in their JSONRPC notification; SourceManager parses + coerces it and
 * forwards the resolved mode to the broadcast callback as the 4th
 * argument. The downstream extension maps it 1:1 to `pi.sendMessage`
 * options — the routing decision is fully owned by SourceManager.
 *
 * The vocabulary mirrors the user-facing TUI Enter / Ctrl+Enter
 * distinction so source authors don't have to think about internal
 * queue mechanics:
 *
 * - "next":  queue at the start of the agent's next turn (default for
 *            most messages, e.g. lark chats, health reports). Maps to
 *            `{ triggerTurn: true }` at the extension layer.
 * - "steer": interrupt the current turn and inject immediately
 *            (urgent events). Maps to `{ deliverAs: "steer" }` at the
 *            extension layer.
 *
 * The previous `params.deliverAs` ("steer" | "followUp" | "prompt")
 * and `params.drainMode` ("all" | "one-at-a-time") fields have been
 * collapsed into this single `mode` field. drainMode is no longer
 * exposed at the source layer — the extension always batches
 * ("all") internally.
 */
export type MessageMode = "next" | "steer";

/** Coerce a JSONRPC `params.mode` value into a valid mode (default: "next"). */
function coerceMode(raw: unknown): MessageMode {
	if (raw === "next" || raw === "steer") {
		return raw;
	}
	return "next";
}

export class SourceManager {
	private readonly _sources = new Map<string, SourceRecord>();
	private readonly _onBroadcast: (
		sourceName: string,
		line: string,
		subscriberAgentIds: string[],
		mode: MessageMode,
	) => void;
	private readonly _initialRestartDelayMs: number;
	private readonly _maxRestartDelayMs: number;
	private readonly _maxRestartAttempts: number;

	constructor(onBroadcast: SourceManager["_onBroadcast"], options: SourceManagerOptions = {}) {
		this._onBroadcast = onBroadcast;
		this._initialRestartDelayMs = options.initialRestartDelayMs ?? INITIAL_RESTART_DELAY_MS;
		this._maxRestartDelayMs = options.maxRestartDelayMs ?? MAX_RESTART_DELAY_MS;
		this._maxRestartAttempts = options.maxRestartAttempts ?? MAX_RESTART_ATTEMPTS;
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
			stdoutReader: undefined,
			stderrReader: undefined,
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

	/**
	 * Inspector used by tests and operators to see the supervisor's view of a
	 * source: how many times it has been restarted and what its lifecycle
	 * status is. Returns undefined if no source is registered under `name`.
	 */
	getSourceStats(name: string): { status: SourceStatus; restartCount: number; destroyed: boolean } | undefined {
		const record = this._sources.get(name);
		if (!record) return undefined;
		return {
			status: record.status,
			restartCount: record.restartCount,
			destroyed: record.destroyed,
		};
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
		// Invoke the child as a real argv vector (no shell). With `shell: true`
		// we used to glue `command` and `args` with single spaces and hand the
		// whole thing to `/bin/sh -c`, which silently broke multi-word args
		// such as `sh -c "exit 7"` because the inner quote pair was lost when
		// the args were re-tokenised by the shell — `sh -c exit 7` parses as
		// `sh -c` with `exit` as the script and `7` as `$0`, so the child
		// always exited 0 instead of 7. Spawning with an explicit argv array
		// preserves the original token boundaries verbatim. Users who need
		// shell features (pipes, redirects, globs, variable expansion) can
		// opt in explicitly with `command: "sh"`, `args: ["-c", "cmd | tee log"]`.
		const child = spawn(record.command, record.args, {
			cwd: record.cwd,
			env: record.env ? { ...process.env, ...record.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: true,
		});

		record.process = child;
		record.status = "running";

		const stdoutReader = createInterface({ input: child.stdout! });
		stdoutReader.on("line", (line) => {
			try {
				const result = validateLine(line);
				switch (result.kind) {
					case "notification":
						this._onLine(record.name, line);
						break;
					case "request":
					case "response":
					case "invalid":
						// Silent drop. Source is push-only (request/response
						// have no business here), and invalid lines are not
						// the hub's problem to diagnose — that's the source's
						// own contract. Per the "only valuable output"
						// principle, no stderr warning either.
						break;
				}
			} catch (err) {
				// Validator itself threw — log and continue. Never crash the source.
				process.stderr.write(`[d-pi source] Source "${record.name}" validator threw: ${(err as Error).message}\n`);
			}
		});
		record.stdoutReader = stdoutReader;

		const stderrReader = createInterface({ input: child.stderr! });
		stderrReader.on("line", (line) => {
			this._onLine(record.name, `[stderr] ${line}`);
		});
		record.stderrReader = stderrReader;

		child.on("error", (err) => {
			process.stderr.write(`[d-pi source] Source "${record.name}" process error: ${err.message}\n`);
			record.process = undefined;
			this._closeReaders(record);
			if (record.destroyed) return;
			record.status = "error";
			this._notifyCreator(
				record,
				`Source "${record.name}" encountered a process error: ${err.message}. Restarting with exponential backoff.`,
			);
			this._scheduleRestart(record);
		});

		child.on("exit", (code, signal) => {
			process.stderr.write(`[d-pi source] Source "${record.name}" exited with code=${code} signal=${signal}\n`);
			record.process = undefined;
			this._closeReaders(record);
			if (record.destroyed) return;

			// A Source is a long-running supervised process. Every non-destroyed
			// exit (code 0, non-zero, or signal) is treated as a supervisor-level
			// failure and is eligible for restart. Treating `code === 0` as
			// "normal completion" is wrong: long-running consumers like
			// `lark-cli event consume` exit cleanly (code 0) when the internal
			// bus daemon goes idle, when the WebSocket drops, or when stdin is
			// closed. Those are not user-initiated stops and must be recovered.
			record.status = "stopped";
			this._notifyCreator(
				record,
				`Source "${record.name}" exited (code=${code}, signal=${signal}). Restarting with exponential backoff.`,
			);
			this._scheduleRestart(record);
		});
	}

	private _scheduleRestart(record: SourceRecord): void {
		if (record.destroyed) return;
		if (record.restartTimer) return; // Already scheduled

		// If we have already burned through our budget of restart attempts,
		// give up: mark the source as failed, surface a final [source-error]
		// to the creator, and stop supervising. This bounds the restart loop
		// for persistently crashing children (e.g. a misconfigured command)
		// while still recovering transparently from transient blips.
		if (record.restartCount >= this._maxRestartAttempts) {
			record.status = "failed";
			this._notifyCreator(
				record,
				`Source "${record.name}" failed after ${record.restartCount} restart attempts; giving up. Last operator action required: destroy and recreate the source, or fix the underlying command.`,
			);
			process.stderr.write(
				`[d-pi source] Source "${record.name}" giving up after ${record.restartCount} restart attempts\n`,
			);
			return;
		}

		const delay = Math.min(this._initialRestartDelayMs * 2 ** record.restartCount, this._maxRestartDelayMs);
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
		if (!record || record.destroyed || record.subscribers.size === 0) return;

		const subscriberIds = Array.from(record.subscribers);

		// Parse the JSONRPC notification so we can extract the mode.
		// The validator already classified this line as a notification,
		// so JSON.parse should succeed — but stay defensive (try/catch)
		// so a parsing bug can never crash the supervisor.
		let mode: MessageMode = "next";
		try {
			const parsed = JSON.parse(line) as {
				params?: { mode?: unknown };
			};
			if (parsed && typeof parsed === "object" && parsed.params && typeof parsed.params === "object") {
				mode = coerceMode(parsed.params.mode);
			}
		} catch {
			// Shouldn't happen for validated notifications, but stay safe.
			mode = "next";
		}

		this._onBroadcast(sourceName, line, subscriberIds, mode);
	}

	private _notifyCreator(record: SourceRecord, message: string): void {
		if (!record.creatorAgentId) return;
		// Supervisor-error notifications are operational infra, not source
		// content — use the default "next" mode so they flow with normal
		// delivery (turn-start injection, batches with other queue items).
		this._onBroadcast(record.name, `[source-error] ${message}`, [record.creatorAgentId], "next");
	}

	private _closeReaders(record: SourceRecord): void {
		if (record.stdoutReader) {
			record.stdoutReader.close();
			record.stdoutReader = undefined;
		}
		if (record.stderrReader) {
			record.stderrReader.close();
			record.stderrReader = undefined;
		}
	}

	private _destroyRecord(record: SourceRecord): void {
		record.destroyed = true;
		record.subscribers.clear();
		if (record.restartTimer) {
			clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
		}
		this._closeReaders(record);
		this._killProcess(record);
		this._sources.delete(record.name);
	}

	private _killProcess(record: SourceRecord): void {
		const child = record.process;
		record.process = undefined;
		record.status = "stopped";

		if (!child || child.killed) return;

		const pid = child.pid;

		// Kill the entire process group (detached: true ensures own group)
		try {
			if (pid) process.kill(-pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}

		// Force-kill after 3s if SIGTERM wasn't enough
		setTimeout(() => {
			try {
				if (pid) process.kill(-pid, 0);
				if (pid) process.kill(-pid, "SIGKILL");
			} catch {
				// Already dead
			}
		}, 3000);
	}
}
