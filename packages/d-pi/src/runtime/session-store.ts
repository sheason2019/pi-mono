import { resolve } from "node:path";
import type { JsonlSessionMetadata, Session } from "@earendil-works/pi-agent-core/node";
import { JsonlSessionRepo, NodeExecutionEnv, SessionError } from "@earendil-works/pi-agent-core/node";
import { createDPiRuntimeError } from "./errors.ts";
import type { DPiRuntimeSessionInfo } from "./types.ts";

export interface DPiSessionStoreOptions {
	cwd: string;
	sessionsRoot: string;
	env?: NodeExecutionEnv;
}

export interface DPiSessionCreateOptions {
	id?: string;
	cwd?: string;
	parentSessionPath?: string;
}

export interface DPiSessionListOptions {
	cwd?: string;
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

function toRuntimeInfo(metadata: JsonlSessionMetadata): DPiRuntimeSessionInfo {
	return {
		id: metadata.id,
		path: metadata.path,
	};
}

function mapSessionError(error: unknown): never {
	if (error instanceof SessionError) {
		const code = error.code === "not_found" || error.code === "invalid_session" ? "invalid_session" : "unknown";
		throw createDPiRuntimeError(code, error.message, {
			details: { sessionErrorCode: error.code },
		});
	}
	throw error;
}

export class DPiSessionStore {
	private readonly cwd: string;
	private readonly repo: JsonlSessionRepo;

	constructor(options: DPiSessionStoreOptions) {
		this.cwd = resolve(options.cwd);
		const env = options.env ?? new NodeExecutionEnv({ cwd: this.cwd });
		this.repo = new JsonlSessionRepo({
			fs: env,
			sessionsRoot: options.sessionsRoot,
		});
	}

	async create(options: DPiSessionCreateOptions = {}): Promise<DPiSessionHandle> {
		try {
			const session = await this.repo.create({
				id: options.id,
				cwd: resolve(options.cwd ?? this.cwd),
				parentSessionPath: options.parentSessionPath,
			});
			const metadata = await session.getMetadata();
			return { session, metadata, info: toRuntimeInfo(metadata) };
		} catch (error) {
			mapSessionError(error);
		}
	}

	async open(sessionId: string): Promise<DPiSessionHandle> {
		try {
			const metadata = (await this.repo.list()).find((candidate) => candidate.id === sessionId);
			if (!metadata) {
				throw new SessionError("not_found", `Session not found: ${sessionId}`);
			}
			const session = await this.repo.open(metadata);
			return { session, metadata, info: toRuntimeInfo(metadata) };
		} catch (error) {
			mapSessionError(error);
		}
	}

	async openRecent(options: DPiSessionListOptions = {}): Promise<DPiSessionHandle | undefined> {
		try {
			const cwd = options.cwd ? resolve(options.cwd) : this.cwd;
			const [metadata] = await this.repo.list({ cwd });
			if (!metadata) {
				return undefined;
			}
			const session = await this.repo.open(metadata);
			return { session, metadata, info: toRuntimeInfo(metadata) };
		} catch (error) {
			mapSessionError(error);
		}
	}

	async list(options: DPiSessionListOptions = {}): Promise<DPiSessionStoreEntry[]> {
		try {
			const cwd = options.cwd ? resolve(options.cwd) : undefined;
			return (await this.repo.list({ cwd })).map(toEntry);
		} catch (error) {
			mapSessionError(error);
		}
	}
}
