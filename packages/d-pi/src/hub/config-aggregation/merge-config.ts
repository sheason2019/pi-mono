import type {
	AuthStorageData,
	ConfigLayerSource,
	PeerConfigJsonLayers,
	PeerExtensionSnapshot,
	PeerPromptSnapshot,
	PeerThemeSnapshot,
} from "./types.js";

export interface MergedConfigLayers {
	auth: AuthStorageData;
	models: unknown;
	settings: unknown;
	mcp: unknown;
	contextFiles: Array<{ path: string; content: string }>;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	prompts: PeerPromptSnapshot[];
	themes: PeerThemeSnapshot[];
	extensions: PeerExtensionSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namespaceMcp(mcp: unknown, source: ConfigLayerSource | undefined): unknown {
	if (source?.kind === "peer") {
		return undefined;
	}
	return mcp;
}

function namespaceLayer(layer: PeerConfigJsonLayers): PeerConfigJsonLayers {
	return {
		...layer,
		mcp: namespaceMcp(layer.mcp, layer.source),
	};
}

function isModelArray(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
	return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.id === "string");
}

function mergeModelArrays(
	left: Array<Record<string, unknown> & { id: string }>,
	right: Array<Record<string, unknown> & { id: string }>,
): Array<Record<string, unknown> & { id: string }> {
	const out = left.map((model) => ({ ...model }));
	const indexById = new Map<string, number>();
	for (let i = 0; i < out.length; i++) {
		indexById.set(out[i]!.id, i);
	}
	for (const model of right) {
		const existingIndex = indexById.get(model.id);
		if (existingIndex === undefined) {
			indexById.set(model.id, out.length);
			out.push({ ...model });
			continue;
		}
		const merged = deepMerge(out[existingIndex], model);
		out[existingIndex] = isRecord(merged)
			? ({ ...merged, id: model.id } as Record<string, unknown> & { id: string })
			: { ...model };
	}
	return out;
}

function deepMerge(left: unknown, right: unknown): unknown {
	if (isModelArray(left) && isModelArray(right)) {
		return mergeModelArrays(left, right);
	}
	if (!isRecord(left) || !isRecord(right)) {
		return right ?? left;
	}
	const out: Record<string, unknown> = { ...left };
	for (const [key, value] of Object.entries(right)) {
		out[key] = key in out ? deepMerge(out[key], value) : value;
	}
	return out;
}

function mergeMcp(left: unknown, right: unknown): unknown {
	if (!isRecord(left) || !Array.isArray(left.servers)) {
		return right ?? left;
	}
	if (!isRecord(right) || !Array.isArray(right.servers)) {
		return left;
	}
	const merged = deepMerge(left, right);
	return {
		...(isRecord(merged) ? merged : {}),
		servers: [...left.servers, ...right.servers],
	};
}

export function mergeConfigLayers(layers: Array<PeerConfigJsonLayers | undefined>): MergedConfigLayers {
	let auth: AuthStorageData = {};
	let models: unknown = { providers: {} };
	let settings: unknown = {};
	let mcp: unknown = { servers: [] };
	const contextFiles: Array<{ path: string; content: string }> = [];
	const contextFilePaths = new Set<string>();
	let systemPrompt: string | undefined;
	const appendSystemPrompt: string[] = [];
	const prompts: PeerPromptSnapshot[] = [];
	const themes: PeerThemeSnapshot[] = [];
	const extensions: PeerExtensionSnapshot[] = [];

	for (const layer of layers) {
		if (!layer) {
			continue;
		}
		const normalizedLayer = namespaceLayer(layer);
		if (normalizedLayer.auth) {
			auth = { ...auth, ...normalizedLayer.auth };
		}
		if (normalizedLayer.models !== undefined) {
			models = deepMerge(models, normalizedLayer.models);
		}
		if (normalizedLayer.settings !== undefined) {
			settings = deepMerge(settings, normalizedLayer.settings);
		}
		if (normalizedLayer.mcp !== undefined) {
			mcp = mergeMcp(mcp, normalizedLayer.mcp);
		}
		if (normalizedLayer.contextFiles) {
			for (const cf of normalizedLayer.contextFiles) {
				if (!contextFilePaths.has(cf.path)) {
					contextFiles.push(cf);
					contextFilePaths.add(cf.path);
				}
			}
		}
		if (normalizedLayer.systemPrompt !== undefined) {
			systemPrompt = normalizedLayer.systemPrompt;
		}
		if (normalizedLayer.appendSystemPrompt) {
			appendSystemPrompt.push(...normalizedLayer.appendSystemPrompt);
		}
		if (normalizedLayer.prompts) {
			prompts.push(...normalizedLayer.prompts);
		}
		if (normalizedLayer.themes) {
			themes.push(...normalizedLayer.themes);
		}
		if (normalizedLayer.extensions) {
			extensions.push(...normalizedLayer.extensions);
		}
	}

	return { auth, models, settings, mcp, contextFiles, systemPrompt, appendSystemPrompt, prompts, themes, extensions };
}
