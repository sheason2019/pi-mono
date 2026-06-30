import { dirname, join } from "node:path";
import type {
	FileSystem,
	JsonlSessionMetadata,
	SessionStorage,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core/node";
import { getFileSystemResultOrThrow, SessionError, uuidv7 } from "@earendil-works/pi-agent-core/node";

type DpiSegmentedFs = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile" | "createDir">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

function parseHeaderLine(
	line: string,
	filePath: string,
): {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", error as Error);
	}
	if (!isRecord(parsed)) throw invalidSession(filePath, "first line is not a valid session header");
	if (parsed.type !== "session") throw invalidSession(filePath, "first line is not a valid session header");
	if (parsed.version !== 3) throw invalidSession(filePath, "unsupported session version");
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidSession(filePath, "session header is missing id");
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp)
		throw invalidSession(filePath, "session header is missing timestamp");
	if (typeof parsed.cwd !== "string" || !parsed.cwd) throw invalidSession(filePath, "session header is missing cwd");
	if (parsed.parentSession !== undefined && typeof parsed.parentSession !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	return {
		type: "session",
		version: 3,
		id: parsed.id,
		timestamp: parsed.timestamp,
		cwd: parsed.cwd,
		parentSession: parsed.parentSession,
	};
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new SessionError(
			"invalid_entry",
			`Invalid JSONL session file ${filePath}: line ${lineNumber} is not valid JSON`,
			error as Error,
		);
	}
	if (!isRecord(parsed))
		throw new SessionError(
			"invalid_entry",
			`Invalid JSONL session file ${filePath}: line ${lineNumber} is not a valid session entry`,
		);
	if (typeof parsed.type !== "string")
		throw new SessionError(
			"invalid_entry",
			`Invalid JSONL session file ${filePath}: line ${lineNumber} is missing entry type`,
		);
	if (typeof parsed.id !== "string" || !parsed.id)
		throw new SessionError(
			"invalid_entry",
			`Invalid JSONL session file ${filePath}: line ${lineNumber} is missing entry id`,
		);
	if (parsed.parentId !== null && typeof parsed.parentId !== "string") {
		throw new SessionError(
			"invalid_entry",
			`Invalid JSONL session file ${filePath}: line ${lineNumber} has invalid parentId`,
		);
	}
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw new SessionError(
			"invalid_entry",
			`Invalid JSONL session file ${filePath}: line ${lineNumber} is missing timestamp`,
		);
	}
	return parsed as unknown as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? (entry.targetId as string | null) : entry.id;
}

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId as string, label);
	} else {
		labelsById.delete(entry.targetId as string);
	}
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

function generateEntryId(byId: Map<string, SessionTreeEntry>): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv7().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

interface LoadedStorage {
	header: ReturnType<typeof parseHeaderLine>;
	entries: SessionTreeEntry[];
	leafId: string | null;
}

async function loadStorage(fs: DpiSegmentedFs, filePath: string): Promise<LoadedStorage> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) {
		throw invalidSession(filePath, "missing session header");
	}
	const header = parseHeaderLine(lines[0]!, filePath);
	const entries: SessionTreeEntry[] = [];
	let leafId: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const entry = parseEntryLine(lines[i]!, filePath, i + 1);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}
	return { header, entries, leafId };
}

function segmentsDirFor(filePath: string): string {
	return join(dirname(filePath), ".segments");
}

function serializeEntries(entries: SessionTreeEntry[]): string {
	return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

export class DpiSegmentedJsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: DpiSegmentedFs;
	private readonly filePath: string;
	private header: LoadedStorage["header"];
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;
	private metadata: JsonlSessionMetadata;
	private segmentSequence = 0;

	private constructor(
		fs: DpiSegmentedFs,
		filePath: string,
		header: LoadedStorage["header"],
		entries: SessionTreeEntry[],
		leafId: string | null,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.header = header;
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
		this.metadata = {
			id: header.id,
			createdAt: header.timestamp,
			cwd: header.cwd,
			path: filePath,
			...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
		};
	}

	static async open(fs: DpiSegmentedFs, filePath: string): Promise<DpiSegmentedJsonlSessionStorage> {
		const loaded = await loadStorage(fs, filePath);
		return new DpiSegmentedJsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
	}

	static async create(
		fs: DpiSegmentedFs,
		filePath: string,
		options: { cwd: string; sessionId: string; parentSessionPath?: string },
	): Promise<DpiSegmentedJsonlSessionStorage> {
		const header = {
			type: "session" as const,
			version: 3 as const,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			...(options.parentSessionPath ? { parentSession: options.parentSessionPath } : {}),
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new DpiSegmentedJsonlSessionStorage(fs, filePath, header, [], null);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry = {
			type: "leaf" as const,
			id: generateEntryId(this.byId),
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		} satisfies SessionTreeEntry as SessionTreeEntry;
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session leaf ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.currentLeafId = leafId;
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		updateLabelCache(this.labelsById, entry);
		this.currentLeafId = leafIdAfterEntry(entry);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry) => entry.type === type) as Array<Extract<SessionTreeEntry, { type: TType }>>;
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let current: SessionTreeEntry | undefined = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}

	async archiveBefore(firstKeptEntryId: string): Promise<void> {
		const keptIndex = this.entries.findIndex((e) => e.id === firstKeptEntryId);
		if (keptIndex < 0) {
			throw new SessionError("not_found", `Entry ${firstKeptEntryId} not found for archival`);
		}
		if (keptIndex === 0) return;

		const archivedEntries = this.entries.slice(0, keptIndex);
		const keptEntries = this.entries.slice(keptIndex);

		const firstKept = keptEntries[0]!;
		const detachedFirst = { ...firstKept, parentId: null } as SessionTreeEntry;
		keptEntries[0] = detachedFirst;

		const segDir = segmentsDirFor(this.filePath);
		const segResult = await this.fs.createDir(segDir, { recursive: true });
		if (!segResult.ok) {
			throw new SessionError(
				"storage",
				`Failed to create segments directory: ${segResult.error.message}`,
				segResult.error,
			);
		}
		this.segmentSequence += 1;
		const segFile = join(segDir, `segment-${this.segmentSequence}-${Date.now()}.jsonl`);
		getFileSystemResultOrThrow(
			await this.fs.writeFile(segFile, serializeEntries(archivedEntries)),
			`Failed to write segment file ${segFile}`,
		);

		const mainContent = `${JSON.stringify(this.header)}\n${serializeEntries(keptEntries)}`;
		getFileSystemResultOrThrow(
			await this.fs.writeFile(this.filePath, mainContent),
			`Failed to rewrite session file ${this.filePath} after archival`,
		);

		this.entries = keptEntries;
		this.byId = new Map(keptEntries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(keptEntries);
	}
}

export async function loadDpiSegmentedSessionMetadata(
	fs: DpiSegmentedFs,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(filePath, { maxLines: 1 }),
		`Failed to read session header ${filePath}`,
	);
	const line = lines[0];
	if (line?.trim()) {
		const header = parseHeaderLine(line, filePath);
		return {
			id: header.id,
			createdAt: header.timestamp,
			cwd: header.cwd,
			path: filePath,
			...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
		};
	}
	throw invalidSession(filePath, "missing session header");
}
