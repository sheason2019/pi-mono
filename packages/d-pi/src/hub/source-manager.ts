import type { SourceDefinition } from "../workspace-definition.ts";

export type SourceStatus = "running" | "stopped" | "error";

interface SourceRecord {
	name: string;
	definition: SourceDefinition;
	status: SourceStatus;
	subscribers: Set<string>;
	controller: AbortController;
	restartCount: number;
	restartTimer: ReturnType<typeof setTimeout> | undefined;
	destroyed: boolean;
	workspaceRoot: string;
}

export interface SourceInfo {
	name: string;
	status: SourceStatus;
	subscribers: string[];
	restartCount: number;
}

export interface SourceManagerOptions {
	initialRestartDelayMs?: number;
	maxRestartDelayMs?: number;
}

const INITIAL_RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;

export class SourceManager {
	private readonly sources = new Map<string, SourceRecord>();
	private readonly onBroadcast: (sourceName: string, data: string, subscriberAgentNames: string[]) => void;
	private readonly initialRestartDelayMs: number;
	private readonly maxRestartDelayMs: number;

	constructor(
		onBroadcast: (sourceName: string, data: string, subscriberAgentNames: string[]) => void,
		options: SourceManagerOptions = {},
	) {
		this.onBroadcast = onBroadcast;
		this.initialRestartDelayMs = options.initialRestartDelayMs ?? INITIAL_RESTART_DELAY_MS;
		this.maxRestartDelayMs = options.maxRestartDelayMs ?? MAX_RESTART_DELAY_MS;
	}

	syncSources(
		definitions: Record<string, SourceDefinition>,
		subscribersBySource: ReadonlyMap<string, ReadonlySet<string>>,
		workspaceRoot: string,
	): void {
		for (const [name, record] of this.sources) {
			if (!definitions[name] || definitions[name] !== record.definition) {
				this.destroyRecord(record);
			}
		}
		for (const [name, definition] of Object.entries(definitions)) {
			const existing = this.sources.get(name);
			if (existing) {
				existing.subscribers = new Set(subscribersBySource.get(name) ?? []);
				continue;
			}
			this.createRecord(name, definition, new Set(subscribersBySource.get(name) ?? []), workspaceRoot);
		}
	}

	listSources(): SourceInfo[] {
		return [...this.sources.values()].map((record) => this.toSourceInfo(record));
	}

	getSourceStats(name: string): { status: SourceStatus; restartCount: number; destroyed: boolean } | undefined {
		const record = this.sources.get(name);
		return record
			? { status: record.status, restartCount: record.restartCount, destroyed: record.destroyed }
			: undefined;
	}

	stopAll(): void {
		for (const record of this.sources.values()) {
			this.destroyRecord(record);
		}
		this.sources.clear();
	}

	private createRecord(
		name: string,
		definition: SourceDefinition,
		subscribers: Set<string>,
		workspaceRoot: string,
	): void {
		const record: SourceRecord = {
			name,
			definition,
			status: "stopped",
			subscribers,
			controller: new AbortController(),
			restartCount: 0,
			restartTimer: undefined,
			destroyed: false,
			workspaceRoot,
		};
		this.sources.set(name, record);
		this.runRecord(record);
	}

	private runRecord(record: SourceRecord): void {
		if (record.destroyed) return;
		record.status = "running";
		record.controller = new AbortController();
		const output = (data: string): void => {
			if (record.destroyed || record.controller.signal.aborted) return;
			if (typeof data !== "string") {
				process.stderr.write(`[d-pi source] Source "${record.name}" produced non-string output; dropping\n`);
				return;
			}
			if (record.subscribers.size === 0) return;
			this.onBroadcast(record.name, data, [...record.subscribers]);
		};
		try {
			Promise.resolve(
				record.definition.execute(output, {
					signal: record.controller.signal,
					workspaceRoot: record.workspaceRoot,
					name: record.name,
				}),
			).catch((err: unknown) => this.handleError(record, err));
		} catch (err) {
			this.handleError(record, err);
		}
	}

	private handleError(record: SourceRecord, err: unknown): void {
		if (record.destroyed || record.controller.signal.aborted) return;
		record.status = "error";
		process.stderr.write(
			`[d-pi source] Source "${record.name}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		this.scheduleRestart(record);
	}

	private scheduleRestart(record: SourceRecord): void {
		if (record.destroyed || record.restartTimer) return;
		const delay = Math.min(this.initialRestartDelayMs * 2 ** record.restartCount, this.maxRestartDelayMs);
		record.restartCount += 1;
		record.restartTimer = setTimeout(() => {
			record.restartTimer = undefined;
			this.runRecord(record);
		}, delay);
	}

	private destroyRecord(record: SourceRecord): void {
		record.destroyed = true;
		record.status = "stopped";
		if (record.restartTimer) {
			clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
		}
		record.controller.abort();
		this.sources.delete(record.name);
	}

	private toSourceInfo(record: SourceRecord): SourceInfo {
		return {
			name: record.name,
			status: record.status,
			subscribers: [...record.subscribers],
			restartCount: record.restartCount,
		};
	}
}
