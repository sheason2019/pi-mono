import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type SessionHeader, SessionManager } from "@sheason/pi-coding-agent";
import {
	CHILD_AGENT_DIR_NAME,
	getAgentsConfigPath,
	getLocalPiDir,
	getSessionFile,
	getWorkspaceDir,
	LOCAL_PI_DIR_NAME,
	SESSION_FILE_NAME,
	WORKSPACE_DIR_NAME,
} from "./config.js";

export interface HubWorkspacePaths {
	cwd: string;
	workspaceDir: string;
	sessionFile: string;
}

export interface InitializeWorkspaceResult {
	created: boolean;
	paths: HubWorkspacePaths;
	header: SessionHeader;
}

export interface WorkspaceStatus {
	paths: HubWorkspacePaths;
	initialized: boolean;
	sessionExists: boolean;
	header?: SessionHeader;
}

export interface WorkspaceArchiveResult {
	archivePath: string;
	paths: HubWorkspacePaths;
	includedRoots: string[];
}

export interface ImportWorkspaceArchiveOptions {
	force?: boolean;
}

export class WorkspaceNotInitializedError extends Error {
	constructor(cwd: string) {
		super(`No pi-hub workspace found in ${cwd}. Run "pi-hub init" first.`);
	}
}

const CONSERVATIVE_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSafeAgentId(agentId: string): void {
	if (agentId === "root" || agentId === "main" || CONSERVATIVE_AGENT_ID.test(agentId)) {
		return;
	}
	throw new Error('Invalid agent id: expected "root" or lowercase kebab-case id.');
}

export function getWorkspacePaths(cwd: string = process.cwd()): HubWorkspacePaths {
	return {
		cwd,
		workspaceDir: getWorkspaceDir(cwd),
		sessionFile: getSessionFile(cwd),
	};
}

/** Resolved path for a child agent session file under the hub workspace (does not create directories). */
export function getAgentSessionFile(cwd: string, agentId: string): string {
	assertSafeAgentId(agentId);
	return join(getWorkspaceDir(cwd), "agents", `${agentId}.jsonl`);
}

export function isWorkspaceInitialized(cwd: string = process.cwd()): boolean {
	return existsSync(getWorkspacePaths(cwd).sessionFile);
}

export function readSessionHeader(sessionFile: string): SessionHeader | undefined {
	if (!existsSync(sessionFile)) {
		return undefined;
	}

	const lines = readFileSync(sessionFile, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length === 0) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(lines[0]) as SessionHeader;
		return parsed.type === "session" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function initializeWorkspace(cwd: string = process.cwd()): InitializeWorkspaceResult {
	const paths = getWorkspacePaths(cwd);
	const existingHeader = readSessionHeader(paths.sessionFile);
	if (existingHeader) {
		return { created: false, paths, header: existingHeader };
	}

	mkdirSync(paths.workspaceDir, { recursive: true });

	const sessionManager = SessionManager.open(paths.sessionFile, paths.workspaceDir, cwd);
	const header = sessionManager.getHeader();
	if (!header) {
		throw new Error("Failed to create initial session header.");
	}

	writeFileSync(paths.sessionFile, `${JSON.stringify(header)}\n`, "utf8");
	return { created: true, paths, header };
}

export function cleanWorkspace(cwd: string = process.cwd()): HubWorkspacePaths {
	const paths = getWorkspacePaths(cwd);
	if (existsSync(paths.workspaceDir)) {
		rmSync(paths.workspaceDir, { recursive: true, force: true });
	}
	return paths;
}

export function getWorkspaceStatus(cwd: string = process.cwd()): WorkspaceStatus {
	const paths = getWorkspacePaths(cwd);
	const header = readSessionHeader(paths.sessionFile);
	return {
		paths,
		initialized: header !== undefined,
		sessionExists: existsSync(paths.sessionFile),
		header,
	};
}

export function assertWorkspaceInitialized(cwd: string = process.cwd()): HubWorkspacePaths {
	const status = getWorkspaceStatus(cwd);
	if (!status.initialized) {
		throw new WorkspaceNotInitializedError(cwd);
	}
	return status.paths;
}

export function exportWorkspaceArchive(archivePath: string, cwd: string = process.cwd()): WorkspaceArchiveResult {
	const paths = assertWorkspaceInitialized(cwd);
	const resolvedArchivePath = resolve(archivePath);
	const roots = getExistingArchiveRoots(cwd);
	if (roots.length === 0) {
		throw new Error("No workspace directories found to export.");
	}
	for (const root of roots) {
		if (isPathInside(resolvedArchivePath, root.absolutePath)) {
			throw new Error("Archive path must not be inside the exported workspace directories.");
		}
	}

	mkdirSync(dirname(resolvedArchivePath), { recursive: true });
	const fd = openSync(resolvedArchivePath, "w");
	try {
		for (const root of roots) {
			writeTarDirectory(fd, root.archiveRoot);
			writeTarTree(fd, root.absolutePath, root.archiveRoot);
		}
		writeSync(fd, Buffer.alloc(1024));
	} finally {
		closeSync(fd);
	}
	return {
		archivePath: resolvedArchivePath,
		paths,
		includedRoots: roots.map((root) => root.archiveRoot),
	};
}

export function importWorkspaceArchive(
	archivePath: string,
	cwd: string = process.cwd(),
	options: ImportWorkspaceArchiveOptions = {},
): WorkspaceArchiveResult {
	const paths = getWorkspacePaths(cwd);
	const resolvedArchivePath = resolve(archivePath);
	const archive = readFileSync(resolvedArchivePath);
	const entries = readTarEntries(archive);
	const roots = [...new Set(entries.map((entry) => getAllowedArchiveRoot(entry.name)))];
	if (roots.length === 0) {
		throw new Error("Archive does not contain .pi-hub, .pi, or .child-agent workspace directories.");
	}
	validateArchiveEntries(entries);

	const existingRoots = WORKSPACE_ARCHIVE_ROOTS.map((root) => ({ root, absolutePath: join(cwd, root) })).filter(
		(root) => existsSync(root.absolutePath),
	);
	if (existingRoots.length > 0 && options.force !== true) {
		throw new Error(
			`Workspace directory already exists: ${existingRoots.map((root) => root.root).join(", ")}. Use --force to overwrite.`,
		);
	}
	for (const root of existingRoots) {
		rmSync(root.absolutePath, { recursive: true, force: true });
	}
	extractTarEntries(entries, cwd);
	rewriteImportedAgentSessionFiles(cwd);

	return {
		archivePath: resolvedArchivePath,
		paths,
		includedRoots: roots,
	};
}

type ArchiveRoot = {
	archiveRoot: WorkspaceArchiveRootName;
	absolutePath: string;
};

type TarEntry = {
	name: string;
	type: "file" | "directory";
	mode: number;
	size: number;
	content: Buffer;
};

const TAR_BLOCK_SIZE = 512;
const TAR_FILE_TYPE = "0";
const TAR_DIRECTORY_TYPE = "5";
const WORKSPACE_ARCHIVE_ROOTS = [WORKSPACE_DIR_NAME, LOCAL_PI_DIR_NAME, CHILD_AGENT_DIR_NAME] as const;

type WorkspaceArchiveRootName = (typeof WORKSPACE_ARCHIVE_ROOTS)[number];

function getExistingArchiveRoots(cwd: string): ArchiveRoot[] {
	const roots: ArchiveRoot[] = [];
	const workspaceDir = getWorkspaceDir(cwd);
	const localPiDir = getLocalPiDir(cwd);
	const childAgentDir = join(cwd, CHILD_AGENT_DIR_NAME);
	if (existsSync(workspaceDir)) {
		roots.push({ archiveRoot: WORKSPACE_DIR_NAME, absolutePath: workspaceDir });
	}
	if (existsSync(localPiDir)) {
		roots.push({ archiveRoot: LOCAL_PI_DIR_NAME, absolutePath: localPiDir });
	}
	if (existsSync(childAgentDir)) {
		roots.push({ archiveRoot: CHILD_AGENT_DIR_NAME, absolutePath: childAgentDir });
	}
	return roots;
}

function writeTarTree(fd: number, absoluteRoot: string, archiveRoot: string): void {
	const names = readdirSync(absoluteRoot).sort();
	for (const name of names) {
		const absolutePath = join(absoluteRoot, name);
		const archiveName = `${archiveRoot}/${name}`;
		const stat = statSync(absolutePath);
		if (stat.isDirectory()) {
			writeTarDirectory(fd, archiveName);
			writeTarTree(fd, absolutePath, archiveName);
			continue;
		}
		if (!stat.isFile()) {
			throw new Error(`Unsupported workspace entry type: ${absolutePath}`);
		}
		writeTarFile(fd, archiveName, readFileSync(absolutePath), stat.mode, stat.mtimeMs);
	}
}

function writeTarDirectory(fd: number, name: string): void {
	writeSync(fd, createTarHeader(`${trimTrailingSlash(name)}/`, TAR_DIRECTORY_TYPE, 0, 0o755, Date.now()));
}

function writeTarFile(fd: number, name: string, content: Buffer, mode: number, mtimeMs: number): void {
	writeSync(fd, createTarHeader(name, TAR_FILE_TYPE, content.byteLength, mode, mtimeMs));
	writeSync(fd, content);
	const padding = getTarPadding(content.byteLength);
	if (padding > 0) {
		writeSync(fd, Buffer.alloc(padding));
	}
}

function createTarHeader(name: string, typeFlag: string, size: number, mode: number, mtimeMs: number): Buffer {
	const header = Buffer.alloc(TAR_BLOCK_SIZE);
	const normalizedName = normalizeTarName(name);
	const { namePart, prefixPart } = splitTarName(normalizedName);
	writeTarString(header, 0, 100, namePart);
	writeTarOctal(header, 100, 8, mode & 0o777);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, size);
	writeTarOctal(header, 136, 12, Math.floor(mtimeMs / 1000));
	header.fill(0x20, 148, 156);
	writeTarString(header, 156, 1, typeFlag);
	writeTarString(header, 257, 6, "ustar");
	writeTarString(header, 263, 2, "00");
	if (prefixPart) {
		writeTarString(header, 345, 155, prefixPart);
	}
	let checksum = 0;
	for (const byte of header) {
		checksum += byte;
	}
	writeTarOctal(header, 148, 8, checksum);
	return header;
}

function readTarEntries(archive: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.byteLength; ) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		offset += TAR_BLOCK_SIZE;
		if (header.every((byte) => byte === 0)) {
			break;
		}
		const name = readTarName(header);
		const size = readTarOctal(header, 124, 12);
		const typeFlag = header.toString("utf8", 156, 157).replace(/\0/g, "") || TAR_FILE_TYPE;
		const contentStart = offset;
		const contentEnd = contentStart + size;
		if (contentEnd > archive.byteLength) {
			throw new Error(`Invalid tar archive: entry "${name}" exceeds archive size.`);
		}
		const content = archive.subarray(contentStart, contentEnd);
		offset = contentEnd + getTarPadding(size);
		if (typeFlag === TAR_DIRECTORY_TYPE) {
			entries.push({ name, type: "directory", mode: 0o755, size, content: Buffer.alloc(0) });
			continue;
		}
		if (typeFlag === TAR_FILE_TYPE) {
			entries.push({ name, type: "file", mode: readTarOctal(header, 100, 8), size, content });
			continue;
		}
		throw new Error(`Unsupported tar entry type for "${name}".`);
	}
	return entries;
}

function validateArchiveEntries(entries: readonly TarEntry[]): void {
	for (const entry of entries) {
		getAllowedArchiveRoot(entry.name);
		const parts = trimTrailingSlash(normalizeTarName(entry.name)).split("/");
		if (parts.some((part) => part === ".." || part === "")) {
			throw new Error(`Invalid tar entry path: ${entry.name}`);
		}
	}
}

function extractTarEntries(entries: readonly TarEntry[], cwd: string): void {
	const targetRoot = resolve(cwd);
	for (const entry of entries) {
		const target = resolve(targetRoot, normalizeTarName(entry.name));
		if (!isPathInsideOrEqual(target, targetRoot)) {
			throw new Error(`Invalid tar entry path: ${entry.name}`);
		}
		if (entry.type === "directory") {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, entry.content, { mode: entry.mode });
	}
}

function rewriteImportedAgentSessionFiles(cwd: string): void {
	const agentsConfigPath = getAgentsConfigPath(cwd);
	if (!existsSync(agentsConfigPath)) {
		return;
	}
	const parsed = JSON.parse(readFileSync(agentsConfigPath, "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return;
	}
	const file = parsed as { agents?: unknown };
	if (!Array.isArray(file.agents)) {
		return;
	}

	let changed = false;
	for (const raw of file.agents) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			continue;
		}
		const record = raw as Record<string, unknown>;
		const id = record.id === "main" ? "root" : record.id;
		if (typeof id !== "string") {
			continue;
		}
		const sessionFile = resolveImportedSessionFile(cwd, id, record.kind);
		if (sessionFile !== undefined && record.sessionFile !== sessionFile) {
			record.sessionFile = sessionFile;
			changed = true;
		}
	}

	if (changed) {
		writeFileSync(agentsConfigPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
	}
}

function resolveImportedSessionFile(cwd: string, agentId: string, kind: unknown): string | undefined {
	if (agentId === "root" || agentId === "main" || kind === "root" || kind === "main") {
		return getSessionFile(cwd);
	}
	try {
		assertSafeAgentId(agentId);
	} catch {
		return undefined;
	}
	const childAgentSessionFile = join(cwd, CHILD_AGENT_DIR_NAME, agentId, SESSION_FILE_NAME);
	const legacyHubAgentSessionFile = getAgentSessionFile(cwd, agentId);
	if (existsSync(childAgentSessionFile)) {
		return childAgentSessionFile;
	}
	if (existsSync(legacyHubAgentSessionFile)) {
		return legacyHubAgentSessionFile;
	}
	return childAgentSessionFile;
}

function getAllowedArchiveRoot(name: string): WorkspaceArchiveRootName {
	const normalized = trimTrailingSlash(normalizeTarName(name));
	const root = normalized.split("/")[0];
	const allowedRoot = WORKSPACE_ARCHIVE_ROOTS.find((candidate) => candidate === root);
	if (allowedRoot !== undefined) {
		return allowedRoot;
	}
	throw new Error(`Archive entry is outside supported workspace roots: ${name}`);
}

function splitTarName(name: string): { namePart: string; prefixPart: string } {
	const encoded = Buffer.from(name);
	if (encoded.byteLength <= 100) {
		return { namePart: name, prefixPart: "" };
	}
	const parts = name.split("/");
	for (let i = 1; i < parts.length; i += 1) {
		const prefixPart = parts.slice(0, i).join("/");
		const namePart = parts.slice(i).join("/");
		if (Buffer.byteLength(prefixPart) <= 155 && Buffer.byteLength(namePart) <= 100) {
			return { namePart, prefixPart };
		}
	}
	throw new Error(`Tar entry path is too long: ${name}`);
}

function readTarName(header: Buffer): string {
	const name = readTarString(header, 0, 100);
	const prefix = readTarString(header, 345, 155);
	return prefix ? `${prefix}/${name}` : name;
}

function normalizeTarName(name: string): string {
	return name.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function trimTrailingSlash(name: string): string {
	return name.endsWith("/") ? name.slice(0, -1) : name;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
	const bytes = Buffer.from(value);
	if (bytes.byteLength > length) {
		throw new Error(`Tar field is too long: ${value}`);
	}
	bytes.copy(buffer, offset, 0, bytes.byteLength);
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
	const raw = buffer.subarray(offset, offset + length);
	const nullIndex = raw.indexOf(0);
	return raw.subarray(0, nullIndex === -1 ? raw.byteLength : nullIndex).toString("utf8");
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
	const text = value.toString(8).padStart(length - 2, "0");
	buffer.write(`${text}\0 `, offset, length, "ascii");
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
	const text = readTarString(buffer, offset, length).trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function getTarPadding(size: number): number {
	return (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
}

function isPathInside(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isPathInsideOrEqual(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}
