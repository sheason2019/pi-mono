import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getMcpConfigPath } from "./mcp-config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFoundError(resourceId: string): string {
	return `MCP server resourceId ${JSON.stringify(resourceId)} not found in mcp config`;
}

type MutateMcpConfigResult = { ok: true } | { ok: false; error: string };

function parseConfigRootOrError(
	filePath: string,
	raw: string,
): { ok: true; root: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, root: JSON.parse(raw) as unknown };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `Failed to parse mcp config at ${filePath}: ${msg}` };
	}
}

function getWorkingArray(root: unknown): { workingArray: unknown[]; root: unknown } {
	if (Array.isArray(root)) {
		return { workingArray: root, root };
	}
	if (isRecord(root)) {
		if (root.servers === undefined) {
			(root as Record<string, unknown>).servers = [];
		} else if (!Array.isArray(root.servers)) {
			throw new Error('Invalid mcp config: "servers" must be an array');
		}
		return { workingArray: (root as { servers: unknown[] }).servers, root };
	}
	throw new Error('Invalid mcp config: root must be a JSON array of servers, or an object with a "servers" array');
}

function findFirstIndexByResourceId(workingArray: unknown[], resourceId: string): number {
	for (let i = 0; i < workingArray.length; i++) {
		const e = workingArray[i];
		if (isRecord(e) && e.resourceId === resourceId) {
			return i;
		}
	}
	return -1;
}

function writeAtomicFile(path: string, value: unknown): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, content, "utf8");
		renameSync(tmp, path);
	} catch (e) {
		try {
			if (existsSync(tmp)) {
				unlinkSync(tmp);
			}
		} catch {
			// best-effort cleanup
		}
		throw e;
	}
}

function mutateMcpConfigFile(
	cwd: string,
	resourceId: string,
	mutate: (workingArray: unknown[], index: number) => void,
	configPath: string = getMcpConfigPath(cwd),
): MutateMcpConfigResult {
	const path = configPath;
	if (!existsSync(path)) {
		return { ok: false, error: notFoundError(resourceId) };
	}
	const parsed = parseConfigRootOrError(path, readFileSync(path, "utf8"));
	if (!parsed.ok) {
		return { ok: false, error: parsed.error };
	}
	const root = parsed.root;
	let workingArray: unknown[];
	try {
		workingArray = getWorkingArray(root).workingArray;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
	const index = findFirstIndexByResourceId(workingArray, resourceId);
	if (index < 0) {
		return { ok: false, error: notFoundError(resourceId) };
	}
	try {
		mutate(workingArray, index);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
	try {
		writeAtomicFile(path, root);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
	return { ok: true };
}

export function pauseServer(cwd: string, resourceId: string, configPath?: string): MutateMcpConfigResult {
	return mutateMcpConfigFile(
		cwd,
		resourceId,
		(workingArray, index) => {
			const entry = workingArray[index];
			if (!isRecord(entry)) {
				throw new Error(notFoundError(resourceId));
			}
			workingArray[index] = { ...entry, disabled: true } as unknown;
		},
		configPath,
	);
}

// Same choice as `resumeSourceInConfig`: remove the `disabled` key rather than set `false`.
export function restartServer(cwd: string, resourceId: string, configPath?: string): MutateMcpConfigResult {
	return mutateMcpConfigFile(
		cwd,
		resourceId,
		(workingArray, index) => {
			const entry = workingArray[index];
			if (!isRecord(entry)) {
				throw new Error(notFoundError(resourceId));
			}
			const next = { ...entry };
			delete next.disabled;
			workingArray[index] = next;
		},
		configPath,
	);
}

export function removeServer(cwd: string, resourceId: string, configPath?: string): MutateMcpConfigResult {
	return mutateMcpConfigFile(
		cwd,
		resourceId,
		(workingArray, index) => {
			workingArray.splice(index, 1);
		},
		configPath,
	);
}
