import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonlSessionMetadata, Session } from "@earendil-works/pi-agent-core/node";
import { JsonlSessionRepo, NodeExecutionEnv, ok, SessionError } from "@earendil-works/pi-agent-core/node";
import { createDPiRuntimeError } from "./errors.ts";
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
		const sessionsRoot = resolve(options.sessionsRoot);
		const env = options.env ?? new NodeExecutionEnv({ cwd: this.cwd });

		const originalJoinPath = env.joinPath.bind(env);
		env.joinPath = async (parts: string[]) => {
			if (parts[0] === sessionsRoot && typeof parts[1] === "string" && /^--.*--$/.test(parts[1])) {
				return ok(join(sessionsRoot, ...parts.slice(2).map(String)));
			}
			return originalJoinPath(parts);
		};

		this.repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
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
			mapSessionError(error);
		}
	}

	async open(sessionId: string): Promise<DPiSessionHandle> {
		try {
			const metadata = (await this.repo.list({ cwd: this.cwd })).find((m) => m.id === sessionId);
			if (!metadata) {
				throw new SessionError("not_found", `Session not found: ${sessionId}`);
			}
			const session = await this.repo.open(metadata);
			mkdirSync(dirname(metadata.path), { recursive: true });
			return { session, metadata, info: { id: metadata.id, path: metadata.path } };
		} catch (error) {
			mapSessionError(error);
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
			mapSessionError(error);
		}
	}

	async list(): Promise<DPiSessionStoreEntry[]> {
		try {
			return (await this.repo.list({ cwd: this.cwd })).map(toEntry);
		} catch (error) {
			mapSessionError(error);
		}
	}
}
