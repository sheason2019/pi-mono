import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonlSessionMetadata, Session } from "@earendil-works/pi-agent-core/node";
import {
	createSessionId,
	getFileSystemResultOrThrow,
	NodeExecutionEnv,
	ok,
	Session as SessionClass,
	toError,
} from "@earendil-works/pi-agent-core/node";
import { createDPiRuntimeError } from "./errors.ts";
import { DpiSegmentedJsonlSessionStorage, loadDpiSegmentedSessionMetadata } from "./session/segmented-jsonl-storage.ts";
import type { DPiRuntimeSessionInfo } from "./types.ts";

export interface DPiSessionStoreOptions {
	cwd: string;
	sessionsRoot: string;
	env?: NodeExecutionEnv;
}

export interface DPiSessionCreateOptions {
	id?: string;
	parentSessionPath?: string;
}

export interface DPiSessionStoreEntry {
	id: string;
	cwd: string;
	path: string;
	createdAt: string;
	parentSessionPath?: string;
}

export interface DPiSessionHandle {
	session: Session<JsonlSessionMetadata>;
	metadata: JsonlSessionMetadata;
	info: DPiRuntimeSessionInfo;
}

function toEntry(metadata: JsonlSessionMetadata): DPiSessionStoreEntry {
	return {
		id: metadata.id,
		cwd: metadata.cwd,
		path: metadata.path,
		createdAt: metadata.createdAt,
		...(metadata.parentSessionPath ? { parentSessionPath: metadata.parentSessionPath } : {}),
	};
}

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

type RepoFs = Pick<
	NodeExecutionEnv,
	| "cwd"
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
>;

class DpiSegmentedSessionRepo {
	private readonly fs: RepoFs;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;

	constructor(fs: RepoFs, sessionsRootInput: string) {
		this.fs = fs;
		this.sessionsRootInput = sessionsRootInput;
	}

	private async getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async createSessionFilePath(cwd: string, sessionId: string, timestamp: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	async create(options: {
		cwd: string;
		id?: string;
		parentSessionPath?: string;
	}): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? createSessionId();
		const createdAt = new Date().toISOString();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
		const storage = await DpiSegmentedJsonlSessionStorage.create(this.fs, filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
		});
		return new SessionClass(storage);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		const existsResult = getFileSystemResultOrThrow(
			await this.fs.exists(metadata.path),
			`Failed to check session ${metadata.path}`,
		);
		if (!existsResult) {
			const err = new Error(`Session not found: ${metadata.path}`) as Error & { code?: string };
			err.code = "not_found";
			throw err;
		}
		const storage = await DpiSegmentedJsonlSessionStorage.open(this.fs, metadata.path);
		return new SessionClass(storage);
	}

	async list(options: { cwd?: string } = {}): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			const dirExists = getFileSystemResultOrThrow(
				await this.fs.exists(dir),
				`Failed to check session directory ${dir}`,
			);
			if (!dirExists) continue;
			const files = getFileSystemResultOrThrow(await this.fs.listDir(dir), `Failed to list sessions in ${dir}`);
			const jsonlFiles = files.filter((f) => f.kind !== "directory" && f.name.endsWith(".jsonl"));
			for (const file of jsonlFiles) {
				try {
					sessions.push(await loadDpiSegmentedSessionMetadata(this.fs, file.path));
				} catch (error) {
					const cause = toError(error);
					if (!("code" in cause) || (cause as Error & { code?: string }).code !== "invalid_session") {
						throw error;
					}
				}
			}
		}
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}

	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
		const rootExists = getFileSystemResultOrThrow(
			await this.fs.exists(sessionsRoot),
			`Failed to check sessions root ${sessionsRoot}`,
		);
		if (!rootExists) return [];
		const entries = getFileSystemResultOrThrow(
			await this.fs.listDir(sessionsRoot),
			`Failed to list sessions root ${sessionsRoot}`,
		);
		return entries.filter((e) => e.kind === "directory" && !e.name.startsWith(".")).map((e) => e.path);
	}
}

export async function archiveSessionBefore(
	session: Session<JsonlSessionMetadata>,
	firstKeptEntryId: string,
): Promise<void> {
	const storage = session.getStorage();
	if (storage instanceof DpiSegmentedJsonlSessionStorage) {
		await storage.archiveBefore(firstKeptEntryId);
	}
}

export class DPiSessionStore {
	private readonly cwd: string;
	private readonly repo: DpiSegmentedSessionRepo;

	constructor(options: DPiSessionStoreOptions) {
		this.cwd = resolve(options.cwd);
		const sessionsRoot = resolve(options.sessionsRoot);
		const env = options.env ?? new NodeExecutionEnv({ cwd: this.cwd });

		const originalJoinPath = env.joinPath.bind(env);
		env.joinPath = async (parts: string[]) => {
			if (parts[0] === sessionsRoot && typeof parts[1] === "string" && /^--.*--$/.test(parts[1])) {
				return ok(resolve(sessionsRoot, ...parts.slice(2).map(String)));
			}
			return originalJoinPath(parts);
		};

		this.repo = new DpiSegmentedSessionRepo(env, sessionsRoot);
	}

	async create(options: DPiSessionCreateOptions = {}): Promise<DPiSessionHandle> {
		try {
			const session = await this.repo.create({
				id: options.id,
				cwd: this.cwd,
				parentSessionPath: options.parentSessionPath,
			});
			const metadata = await session.getMetadata();
			mkdirSync(dirname(metadata.path), { recursive: true });
			return { session, metadata, info: { id: metadata.id, path: metadata.path } };
		} catch (error) {
			this.mapError(error);
		}
	}

	async open(sessionId: string): Promise<DPiSessionHandle> {
		try {
			const metadata = (await this.repo.list({ cwd: this.cwd })).find((m) => m.id === sessionId);
			if (!metadata) {
				throw new Error(`Session not found: ${sessionId}`);
			}
			const session = await this.repo.open(metadata);
			mkdirSync(dirname(metadata.path), { recursive: true });
			return { session, metadata, info: { id: metadata.id, path: metadata.path } };
		} catch (error) {
			this.mapError(error);
		}
	}

	async openRecent(): Promise<DPiSessionHandle | undefined> {
		try {
			const [metadata] = await this.repo.list({ cwd: this.cwd });
			if (!metadata) return undefined;
			const session = await this.repo.open(metadata);
			mkdirSync(dirname(metadata.path), { recursive: true });
			return { session, metadata, info: { id: metadata.id, path: metadata.path } };
		} catch (error) {
			this.mapError(error);
		}
	}

	async list(): Promise<DPiSessionStoreEntry[]> {
		try {
			return (await this.repo.list({ cwd: this.cwd })).map(toEntry);
		} catch (error) {
			this.mapError(error);
		}
	}

	private mapError(error: unknown): never {
		if (error instanceof Error && "code" in error) {
			const code = (error as { code?: string }).code;
			if (code === "not_found" || code === "invalid_session") {
				throw createDPiRuntimeError("invalid_session", error.message, {
					details: { sessionErrorCode: code },
				});
			}
		}
		throw createDPiRuntimeError("unknown", error instanceof Error ? error.message : String(error));
	}
}
