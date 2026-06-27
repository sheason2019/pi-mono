import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { AgentSourceDefinition } from "../agent-definition.ts";
import {
	discoverWorkspaceSourcePaths,
	loadWorkspaceSourceDefinition,
	resolveWorkspaceSourcePath,
} from "../workspace/workspace-resources.ts";

const RESTART_DELAY_MS = 2_000;

interface SourceHandle {
	name: string;
	definition: AgentSourceDefinition;
	filePath: string;
	fileMtime: number;
	process: ChildProcessByStdio<null, Readable, Readable> | undefined;
	subscribers: Set<string>;
	restartTimer: ReturnType<typeof setTimeout> | undefined;
	shutdown: boolean;
	buffer: string;
}

export interface SourceReloadResult {
	added: string[];
	removed: string[];
	changed: string[];
	unchanged: number;
	total: number;
}

export type SourceMessageHandler = (
	agentName: string,
	content: string,
	sourceName: string,
	mode: "next" | "steer",
) => void;

export class SourceManager {
	private readonly workspaceRoot: string;
	private sourcePaths: Record<string, string>;
	private readonly sources = new Map<string, SourceHandle>();
	private onMessage: SourceMessageHandler | undefined;

	constructor(workspaceRoot: string, sourcePaths: Record<string, string>) {
		this.workspaceRoot = resolve(workspaceRoot);
		this.sourcePaths = { ...sourcePaths };
	}

	setMessageHandler(handler: SourceMessageHandler): void {
		this.onMessage = handler;
	}

	async subscribeAgent(agentName: string, sourceNames: string[]): Promise<void> {
		this.unsubscribeAgent(agentName);
		for (const name of sourceNames) {
			await this.ensureSource(name);
			const handle = this.sources.get(name);
			if (!handle) continue;
			handle.subscribers.add(agentName);
			if (!handle.process && !handle.shutdown) {
				this.startSourceProcess(handle);
			}
		}
	}

	unsubscribeAgent(agentName: string, sourceNames?: string[]): void {
		const names = sourceNames ?? [...this.sources.keys()];
		for (const name of names) {
			const handle = this.sources.get(name);
			if (!handle) continue;
			handle.subscribers.delete(agentName);
			if (handle.subscribers.size === 0) {
				this.stopSourceProcess(handle);
			}
		}
	}

	async reload(): Promise<SourceReloadResult> {
		const result: SourceReloadResult = { added: [], removed: [], changed: [], unchanged: 0, total: 0 };

		const newSourcePaths = discoverWorkspaceSourcePaths(this.workspaceRoot);
		const newNames = new Set(Object.keys(newSourcePaths));
		const oldNames = new Set(this.sources.keys());

		for (const name of oldNames) {
			if (!newNames.has(name)) {
				const handle = this.sources.get(name);
				if (handle) {
					handle.shutdown = true;
					this.stopSourceProcess(handle);
					this.sources.delete(name);
					result.removed.push(name);
				}
			}
		}

		this.sourcePaths = { ...newSourcePaths };

		for (const [name, filePath] of Object.entries(newSourcePaths)) {
			const existing = this.sources.get(name);
			let mtime = 0;
			try {
				mtime = statSync(filePath).mtimeMs;
			} catch {
				// file not accessible
			}

			if (!existing) {
				await this.ensureSource(name);
				if (this.sources.has(name)) {
					result.added.push(name);
				}
				continue;
			}

			if (existing.filePath !== filePath || existing.fileMtime !== mtime) {
				try {
					const newDef = await loadWorkspaceSourceDefinition(filePath);
					newDef.name = name;
					const defChanged = sourceDefinitionChanged(existing.definition, newDef);
					existing.definition = newDef;
					existing.filePath = filePath;
					existing.fileMtime = mtime;
					if (defChanged) {
						result.changed.push(name);
						if (existing.subscribers.size > 0 && !existing.shutdown) {
							this.stopSourceProcess(existing);
							this.startSourceProcess(existing);
						}
					} else {
						result.unchanged++;
					}
				} catch (err) {
					process.stderr.write(
						`[d-pi source] Failed to reload source "${name}" from ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				}
			} else {
				result.unchanged++;
			}
		}

		result.total = this.sources.size;
		process.stderr.write(
			`[d-pi source] Reload complete: ${result.added.length} added, ${result.changed.length} changed, ${result.removed.length} removed, ${result.unchanged} unchanged, ${result.total} total\n`,
		);
		return result;
	}

	async stop(): Promise<void> {
		for (const handle of this.sources.values()) {
			handle.shutdown = true;
			this.stopSourceProcess(handle);
		}
		this.sources.clear();
	}

	private async ensureSource(name: string): Promise<void> {
		if (this.sources.has(name)) return;
		const filePath = this.sourcePaths[name] ?? resolveWorkspaceSourcePath(this.workspaceRoot, name);
		if (!filePath || !existsSync(filePath)) {
			process.stderr.write(`[d-pi source] Source "${name}" not found in workspace sources/\n`);
			return;
		}
		try {
			const definition = await loadWorkspaceSourceDefinition(filePath);
			definition.name = name;
			let mtime = 0;
			try {
				mtime = statSync(filePath).mtimeMs;
			} catch {
				// ignore
			}
			this.sources.set(name, {
				name,
				definition,
				filePath,
				fileMtime: mtime,
				process: undefined,
				subscribers: new Set(),
				restartTimer: undefined,
				shutdown: false,
				buffer: "",
			});
			process.stderr.write(`[d-pi source] Loaded source "${name}" (command: ${definition.command})\n`);
		} catch (err) {
			process.stderr.write(
				`[d-pi source] Failed to load source "${name}" from ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	private startSourceProcess(handle: SourceHandle): void {
		const { definition } = handle;
		const cwd = definition.cwd ?? join(this.workspaceRoot, "sources", handle.name);
		const env = { ...process.env, ...(definition.env ?? {}) };

		process.stderr.write(
			`[d-pi source] Starting source "${handle.name}": ${definition.command} ${(definition.args ?? []).join(" ")}\n`,
		);

		const child = spawn(definition.command, definition.args ?? [], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		handle.process = child;
		handle.buffer = "";

		child.stdout.on("data", (chunk: Buffer) => {
			handle.buffer += chunk.toString("utf-8");
			this.flushBuffer(handle);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(`[d-pi source ${handle.name}] ${chunk.toString("utf-8")}`);
		});

		child.on("error", (err) => {
			process.stderr.write(`[d-pi source ${handle.name}] Process error: ${err.message}\n`);
		});

		child.on("exit", (code) => {
			process.stderr.write(`[d-pi source ${handle.name}] Process exited with code ${code}\n`);
			handle.process = undefined;
			if (!handle.shutdown && handle.subscribers.size > 0) {
				process.stderr.write(`[d-pi source ${handle.name}] Restarting in ${RESTART_DELAY_MS}ms...\n`);
				handle.restartTimer = setTimeout(() => {
					handle.restartTimer = undefined;
					if (!handle.shutdown && handle.subscribers.size > 0) {
						this.startSourceProcess(handle);
					}
				}, RESTART_DELAY_MS);
			}
		});
	}

	private stopSourceProcess(handle: SourceHandle): void {
		if (handle.restartTimer) {
			clearTimeout(handle.restartTimer);
			handle.restartTimer = undefined;
		}
		if (handle.process) {
			const child = handle.process;
			handle.process = undefined;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 5_000).unref();
		}
	}

	private flushBuffer(handle: SourceHandle): void {
		const lines = handle.buffer.split("\n");
		handle.buffer = lines.pop() ?? "";
		const mode = handle.definition.mode ?? "next";
		for (const line of lines) {
			const content = line.trim();
			if (content.length === 0) continue;
			this.broadcast(handle, content, mode);
		}
	}

	private broadcast(handle: SourceHandle, content: string, mode: "next" | "steer"): void {
		if (!this.onMessage) return;
		for (const agentName of handle.subscribers) {
			try {
				this.onMessage(agentName, content, handle.name, mode);
			} catch (err) {
				process.stderr.write(
					`[d-pi source ${handle.name}] Failed to dispatch to agent "${agentName}": ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}
}

function sourceDefinitionChanged(a: AgentSourceDefinition, b: AgentSourceDefinition): boolean {
	if (a.command !== b.command) return true;
	if (a.mode !== b.mode) return true;
	if (a.cwd !== b.cwd) return true;
	if (!stringArraysEqual(a.args, b.args)) return true;
	if (!envEqual(a.env, b.env)) return true;
	return false;
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function envEqual(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}
