import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getSourcesConfigPath } from "./source-config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFoundError(resourceId: string): Error {
	return new Error(`Source resourceId ${JSON.stringify(resourceId)} not found in sources config`);
}

function parseConfigRootOrThrow(filePath: string, raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to parse sources config at ${filePath}: ${msg}`);
	}
}

function getWorkingArray(root: unknown): { workingArray: unknown[]; root: unknown } {
	if (Array.isArray(root)) {
		return { workingArray: root, root };
	}
	if (isRecord(root) && Array.isArray(root.sources)) {
		return { workingArray: root.sources, root };
	}
	throw new Error('Invalid sources config: root must be a JSON array of sources, or an object with a "sources" array');
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

function mutateConfigFilePath(
	path: string,
	resourceId: string,
	mutate: (workingArray: unknown[], index: number) => void,
): void {
	if (!existsSync(path)) {
		throw notFoundError(resourceId);
	}
	const root = parseConfigRootOrThrow(path, readFileSync(path, "utf8"));
	const { workingArray } = getWorkingArray(root);
	const index = findFirstIndexByResourceId(workingArray, resourceId);
	if (index < 0) {
		throw notFoundError(resourceId);
	}
	mutate(workingArray, index);
	writeAtomicFile(path, root);
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

export function pauseSourceInConfigFile(path: string, resourceId: string): void {
	mutateConfigFilePath(path, resourceId, (workingArray, index) => {
		const entry = workingArray[index];
		if (!isRecord(entry)) {
			throw notFoundError(resourceId);
		}
		workingArray[index] = { ...entry, disabled: true } as unknown;
	});
}

export function resumeSourceInConfigFile(path: string, resourceId: string): void {
	mutateConfigFilePath(path, resourceId, (workingArray, index) => {
		const entry = workingArray[index];
		if (!isRecord(entry)) {
			throw notFoundError(resourceId);
		}
		const next = { ...entry };
		delete next.disabled;
		workingArray[index] = next;
	});
}

export function removeSourceInConfigFile(path: string, resourceId: string): void {
	mutateConfigFilePath(path, resourceId, (workingArray, index) => {
		workingArray.splice(index, 1);
	});
}

export function pauseSourceInConfig(cwd: string, resourceId: string): void {
	pauseSourceInConfigFile(getSourcesConfigPath(cwd), resourceId);
}

export function resumeSourceInConfig(cwd: string, resourceId: string): void {
	resumeSourceInConfigFile(getSourcesConfigPath(cwd), resourceId);
}

export function removeSourceInConfig(cwd: string, resourceId: string): void {
	removeSourceInConfigFile(getSourcesConfigPath(cwd), resourceId);
}
