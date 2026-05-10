import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getWorkspaceDir } from "./config.js";
import { ensureModelsResourceIds } from "./resource-ids.js";

const LOCAL_PI_DIR_NAME = ".pi";
const MODELS_FILE_NAME = "models.json";
const MERGED_MODELS_FILE_NAME = "merged-models.json";

interface HubModelConfig {
	resourceId?: string;
	id: string;
	[key: string]: unknown;
}

interface HubProviderConfig {
	resourceId?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: Record<string, unknown>;
	models?: HubModelConfig[];
	modelOverrides?: Record<string, Record<string, unknown>>;
}

interface HubModelsConfig {
	providers: Record<string, HubProviderConfig>;
}

export interface HubModelsConfigPaths {
	globalModelsFile: string;
	localModelsFile: string;
	mergedModelsFile: string;
}

export interface MaterializedHubModelsConfig {
	mergedModelsFile: string;
	sourceFiles: string[];
}

export function getHubModelsConfigPaths(cwd: string, agentDir: string = getAgentDir()): HubModelsConfigPaths {
	return {
		globalModelsFile: join(agentDir, MODELS_FILE_NAME),
		localModelsFile: join(cwd, LOCAL_PI_DIR_NAME, MODELS_FILE_NAME),
		mergedModelsFile: join(getWorkspaceDir(cwd), MERGED_MODELS_FILE_NAME),
	};
}

export function materializeMergedModelsConfig(
	cwd: string,
	agentDir: string = getAgentDir(),
): MaterializedHubModelsConfig {
	const paths = getHubModelsConfigPaths(cwd, agentDir);
	for (const path of [paths.globalModelsFile, paths.localModelsFile]) {
		ensureModelsResourceIds(path);
	}
	const globalConfig = readModelsConfig(paths.globalModelsFile);
	const localConfig = readModelsConfig(paths.localModelsFile);
	const mergedConfig = mergeModelsConfig(globalConfig, localConfig);

	mkdirSync(getWorkspaceDir(cwd), { recursive: true });
	writeFileSync(paths.mergedModelsFile, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8");

	return {
		mergedModelsFile: paths.mergedModelsFile,
		sourceFiles: [paths.globalModelsFile, paths.localModelsFile].filter((path) => existsSync(path)),
	};
}

function readModelsConfig(path: string): HubModelsConfig {
	if (!existsSync(path)) {
		return { providers: {} };
	}
	return JSON.parse(readFileSync(path, "utf8")) as HubModelsConfig;
}

function mergeModelsConfig(globalConfig: HubModelsConfig, localConfig: HubModelsConfig): HubModelsConfig {
	const providers: Record<string, HubProviderConfig> = {};
	const providerNames = new Set([
		...Object.keys(globalConfig.providers ?? {}),
		...Object.keys(localConfig.providers ?? {}),
	]);

	for (const providerName of providerNames) {
		providers[providerName] = mergeProviderConfig(
			globalConfig.providers?.[providerName],
			localConfig.providers?.[providerName],
		);
	}

	return { providers };
}

function mergeProviderConfig(
	globalProvider: HubProviderConfig | undefined,
	localProvider: HubProviderConfig | undefined,
): HubProviderConfig {
	if (!globalProvider) {
		return structuredClone(localProvider ?? {});
	}
	if (!localProvider) {
		return structuredClone(globalProvider);
	}

	const merged: HubProviderConfig = {
		...globalProvider,
		...localProvider,
	};

	merged.headers = mergeStringRecord(globalProvider.headers, localProvider.headers);
	merged.compat = mergeUnknownRecord(globalProvider.compat, localProvider.compat);
	merged.modelOverrides = mergeModelOverrides(globalProvider.modelOverrides, localProvider.modelOverrides);
	merged.models = mergeModelConfigs(globalProvider.models, localProvider.models);

	return removeUndefinedFields(merged);
}

function mergeModelConfigs(
	globalModels: HubModelConfig[] | undefined,
	localModels: HubModelConfig[] | undefined,
): HubModelConfig[] | undefined {
	if (!globalModels && !localModels) {
		return undefined;
	}

	const mergedById = new Map<string, HubModelConfig>();
	for (const model of globalModels ?? []) {
		mergedById.set(model.id, structuredClone(model));
	}
	for (const model of localModels ?? []) {
		const previous = mergedById.get(model.id);
		mergedById.set(model.id, previous ? mergeModelConfig(previous, model) : structuredClone(model));
	}

	return [...mergedById.values()];
}

function mergeModelConfig(globalModel: HubModelConfig, localModel: HubModelConfig): HubModelConfig {
	const merged: HubModelConfig = {
		...globalModel,
		...localModel,
	};

	const globalHeaders = asStringRecord(globalModel.headers);
	const localHeaders = asStringRecord(localModel.headers);
	if (globalHeaders || localHeaders) {
		merged.headers = mergeStringRecord(globalHeaders, localHeaders);
	}

	const globalCompat = asUnknownRecord(globalModel.compat);
	const localCompat = asUnknownRecord(localModel.compat);
	if (globalCompat || localCompat) {
		merged.compat = mergeUnknownRecord(globalCompat, localCompat);
	}

	const globalCost = asUnknownRecord(globalModel.cost);
	const localCost = asUnknownRecord(localModel.cost);
	if (globalCost || localCost) {
		merged.cost = mergeUnknownRecord(globalCost, localCost);
	}

	return removeUndefinedFields(merged);
}

function mergeModelOverrides(
	globalOverrides: Record<string, Record<string, unknown>> | undefined,
	localOverrides: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
	if (!globalOverrides && !localOverrides) {
		return undefined;
	}

	const merged: Record<string, Record<string, unknown>> = {};
	const modelIds = new Set([...Object.keys(globalOverrides ?? {}), ...Object.keys(localOverrides ?? {})]);
	for (const modelId of modelIds) {
		merged[modelId] = mergeUnknownRecord(globalOverrides?.[modelId], localOverrides?.[modelId]) ?? {};
	}
	return merged;
}

function mergeStringRecord(
	globalRecord: Record<string, string> | undefined,
	localRecord: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!globalRecord && !localRecord) {
		return undefined;
	}
	return {
		...(globalRecord ?? {}),
		...(localRecord ?? {}),
	};
}

function mergeUnknownRecord(
	globalRecord: Record<string, unknown> | undefined,
	localRecord: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!globalRecord && !localRecord) {
		return undefined;
	}
	return {
		...(globalRecord ?? {}),
		...(localRecord ?? {}),
	};
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as Record<string, string>;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function removeUndefinedFields<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
