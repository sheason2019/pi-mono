import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface EnsureResourceIdOptions {
	createId?: () => string;
}

export interface EnsureNamedResourceIdsResult {
	changed: boolean;
	resourceIdsByName: Map<string, string>;
}

export interface EnsureModelResourceIdsResult {
	changed: boolean;
	providerResourceIdsByName: Map<string, string>;
	modelResourceIdsByProviderAndModel: Map<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function defaultCreateId(): string {
	return randomUUID();
}

function readJson(path: string): unknown | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeAtomicJson(path: string, value: unknown): void {
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (error) {
		try {
			if (existsSync(tmp)) {
				unlinkSync(tmp);
			}
		} catch {
			// best-effort cleanup
		}
		throw error;
	}
}

function getArrayRoot(root: unknown, key: "servers" | "sources"): unknown[] | undefined {
	if (Array.isArray(root)) {
		return root;
	}
	if (!isRecord(root)) {
		return undefined;
	}
	const entries = root[key];
	return Array.isArray(entries) ? entries : undefined;
}

function ensureNamedResourceIds(
	path: string,
	key: "servers" | "sources",
	options: EnsureResourceIdOptions = {},
): EnsureNamedResourceIdsResult {
	const root = readJson(path);
	const entries = root === undefined ? undefined : getArrayRoot(root, key);
	const createId = options.createId ?? defaultCreateId;
	const resourceIdsByName = new Map<string, string>();
	let changed = false;

	for (const entry of entries ?? []) {
		if (!isRecord(entry) || !isNonEmptyString(entry.name)) {
			continue;
		}
		if (!isNonEmptyString(entry.resourceId)) {
			entry.resourceId = createId();
			changed = true;
		}
		const resourceId = entry.resourceId;
		if (isNonEmptyString(resourceId)) {
			resourceIdsByName.set(entry.name, resourceId);
		}
	}

	if (changed && root !== undefined) {
		writeAtomicJson(path, root);
	}
	return { changed, resourceIdsByName };
}

export function ensureMcpResourceIds(
	path: string,
	options: EnsureResourceIdOptions = {},
): EnsureNamedResourceIdsResult {
	return ensureNamedResourceIds(path, "servers", options);
}

export function ensureSourceResourceIds(
	path: string,
	options: EnsureResourceIdOptions = {},
): EnsureNamedResourceIdsResult {
	return ensureNamedResourceIds(path, "sources", options);
}

export function ensureModelsResourceIds(
	path: string,
	options: EnsureResourceIdOptions = {},
): EnsureModelResourceIdsResult {
	const root = readJson(path);
	const createId = options.createId ?? defaultCreateId;
	const providerResourceIdsByName = new Map<string, string>();
	const modelResourceIdsByProviderAndModel = new Map<string, string>();
	let changed = false;

	if (isRecord(root) && isRecord(root.providers)) {
		for (const [providerName, provider] of Object.entries(root.providers)) {
			if (!isRecord(provider)) {
				continue;
			}
			if (!isNonEmptyString(provider.resourceId)) {
				provider.resourceId = createId();
				changed = true;
			}
			const providerResourceId = provider.resourceId;
			if (isNonEmptyString(providerResourceId)) {
				providerResourceIdsByName.set(providerName, providerResourceId);
			}

			if (!Array.isArray(provider.models)) {
				continue;
			}
			for (const model of provider.models) {
				if (!isRecord(model) || !isNonEmptyString(model.id)) {
					continue;
				}
				if (!isNonEmptyString(model.resourceId)) {
					model.resourceId = createId();
					changed = true;
				}
				const modelResourceId = model.resourceId;
				if (isNonEmptyString(modelResourceId)) {
					modelResourceIdsByProviderAndModel.set(`${providerName}:${model.id}`, modelResourceId);
				}
			}
		}
	}

	if (changed && root !== undefined) {
		writeAtomicJson(path, root);
	}
	return { changed, providerResourceIdsByName, modelResourceIdsByProviderAndModel };
}
