import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@sheason/pi-coding-agent";
import { getLocalPiDir } from "../config.js";
import { ensureMcpResourceIds, ensureModelsResourceIds } from "../resource-ids.js";
import type { ConfigLayerSource, PeerConfigJsonLayers, PeerConfigSnapshot } from "./types.js";

function readJson(path: string): unknown | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function readLayerFromDir(
	dir: string,
	includeAuth: boolean,
	source: ConfigLayerSource,
): PeerConfigJsonLayers | undefined {
	const layer: PeerConfigJsonLayers = { source };
	if (includeAuth) {
		const auth = readJson(join(dir, "auth.json"));
		if (auth && typeof auth === "object" && !Array.isArray(auth)) {
			layer.auth = auth as PeerConfigJsonLayers["auth"];
		}
	}
	const modelsPath = join(dir, "models.json");
	ensureModelsResourceIds(modelsPath);
	const models = readJson(modelsPath);
	if (models !== undefined) {
		layer.models = models;
	}
	const settings = readJson(join(dir, "settings.json"));
	if (settings !== undefined) {
		layer.settings = settings;
	}
	const mcpPath = join(dir, "mcp.json");
	ensureMcpResourceIds(mcpPath);
	const mcp = readJson(mcpPath);
	if (mcp !== undefined) {
		layer.mcp = mcp;
	}
	return Object.keys(layer).length > 1 ? layer : undefined;
}

type ResourceSelection = true | Set<string> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHostResourceSelection(value: unknown): ResourceSelection {
	if (value === true) {
		return true;
	}
	if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
		return new Set(value);
	}
	return undefined;
}

function getChildHostMcpSelection(childLayer: PeerConfigJsonLayers | undefined): ResourceSelection {
	if (!isRecord(childLayer?.mcp)) {
		return undefined;
	}
	const ext = childLayer.mcp.extends;
	if (!isRecord(ext) || !isRecord(ext.host)) {
		return undefined;
	}
	return readHostResourceSelection(ext.host.mcp);
}

function filterHostMcpBySelection(
	layer: PeerConfigJsonLayers | undefined,
	selection: ResourceSelection,
): PeerConfigJsonLayers | undefined {
	if (!layer?.mcp) {
		return layer;
	}
	if (selection === true) {
		return layer;
	}
	if (!isRecord(layer.mcp) || !Array.isArray(layer.mcp.servers) || selection === undefined) {
		const { mcp: _mcp, ...rest } = layer;
		return Object.keys(rest).length > 1 ? rest : undefined;
	}
	const servers = layer.mcp.servers.filter(
		(server) => isRecord(server) && typeof server.name === "string" && selection.has(server.name),
	);
	if (servers.length === 0) {
		const { mcp: _mcp, ...rest } = layer;
		return Object.keys(rest).length > 1 ? rest : undefined;
	}
	return { ...layer, mcp: { ...layer.mcp, servers } };
}

function removeChildMcpExtends(layer: PeerConfigJsonLayers | undefined): PeerConfigJsonLayers | undefined {
	if (!isRecord(layer?.mcp) || layer.mcp.extends === undefined) {
		return layer;
	}
	const { extends: _extends, ...mcp } = layer.mcp;
	return { ...layer, mcp };
}

export function buildAgentConfigLayers(options: {
	cwd: string;
	agentDir?: string;
	peerSnapshot?: PeerConfigSnapshot;
	peerSnapshots?: Array<{ peerId: string; snapshot: PeerConfigSnapshot }>;
}): PeerConfigJsonLayers[] {
	const peerSnapshots =
		options.peerSnapshots ?? (options.peerSnapshot ? [{ peerId: "primary", snapshot: options.peerSnapshot }] : []);
	const globalLayer = readLayerFromDir(getAgentDir(), true, { kind: "hub", scope: "global" });
	const workspaceLayer = readLayerFromDir(getLocalPiDir(options.cwd), false, { kind: "hub", scope: "workspace" });
	const childLayer = options.agentDir
		? readLayerFromDir(options.agentDir, true, { kind: "hub", scope: "child" })
		: undefined;
	const hostMcpSelection = options.agentDir ? getChildHostMcpSelection(childLayer) : true;
	const layers: Array<PeerConfigJsonLayers | undefined> = [
		filterHostMcpBySelection(globalLayer, hostMcpSelection),
		filterHostMcpBySelection(workspaceLayer, hostMcpSelection),
		removeChildMcpExtends(childLayer),
		...peerSnapshots.flatMap(({ peerId, snapshot }) => [
			snapshot.global
				? { ...snapshot.global, source: { kind: "peer" as const, peerId, scope: "global" as const } }
				: undefined,
			snapshot.cwdLayer
				? { ...snapshot.cwdLayer, source: { kind: "peer" as const, peerId, scope: "cwd" as const } }
				: undefined,
		]),
	];
	return layers.filter((layer): layer is PeerConfigJsonLayers => layer !== undefined);
}
