import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { PeerConfigJsonLayers, PeerConfigSnapshot } from "../../hub/index.js";

export interface CollectPeerConfigSnapshotOptions {
	cwd?: string;
	agentDir?: string;
	globalDir?: string;
	now?: () => string;
}

function readJsonFile(path: string): unknown | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureMcpResourceIds(path: string): void {
	const root = readJsonFile(path);
	const servers = Array.isArray(root)
		? root
		: isRecord(root) && root.servers === undefined
			? []
			: isRecord(root) && Array.isArray(root.servers)
				? root.servers
				: undefined;
	if (!servers) {
		return;
	}
	let changed = false;
	for (const server of servers) {
		if (isRecord(server) && (typeof server.resourceId !== "string" || server.resourceId.length === 0)) {
			server.resourceId = randomUUID();
			changed = true;
		}
	}
	if (changed) {
		writeAtomicJson(path, root);
	}
}

function ensureModelsResourceIds(path: string): void {
	const root = readJsonFile(path);
	if (!isRecord(root) || !isRecord(root.providers)) {
		return;
	}
	let changed = false;
	for (const provider of Object.values(root.providers)) {
		if (!isRecord(provider)) {
			continue;
		}
		if (typeof provider.resourceId !== "string" || provider.resourceId.length === 0) {
			provider.resourceId = randomUUID();
			changed = true;
		}
		if (!Array.isArray(provider.models)) {
			continue;
		}
		for (const model of provider.models) {
			if (isRecord(model) && (typeof model.resourceId !== "string" || model.resourceId.length === 0)) {
				model.resourceId = randomUUID();
				changed = true;
			}
		}
	}
	if (changed) {
		writeAtomicJson(path, root);
	}
}

function readTextFile(path: string): string | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function readContextFiles(dir: string): Array<{ path: string; content: string }> {
	const out: Array<{ path: string; content: string }> = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = join(dir, name);
		const content = readTextFile(path);
		if (content !== undefined) {
			out.push({ path, content });
		}
	}
	return out;
}

function readSkills(dir: string): NonNullable<PeerConfigJsonLayers["skills"]> {
	const skillsDir = join(dir, "skills");
	if (!existsSync(skillsDir)) {
		return [];
	}
	const loaded = loadSkillsFromDir({ dir: skillsDir, source: "peer" });
	return loaded.skills.flatMap((skill) => {
		const content = readTextFile(skill.filePath);
		if (content === undefined) {
			return [];
		}
		return [
			{
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				content,
				...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
			},
		];
	});
}

function buildLayer(baseDir: string, options: { includeAuth: boolean }): PeerConfigJsonLayers | undefined {
	const layer: PeerConfigJsonLayers = {};
	if (options.includeAuth) {
		const auth = readJsonFile(join(baseDir, "auth.json"));
		if (auth && typeof auth === "object" && !Array.isArray(auth)) {
			layer.auth = auth as PeerConfigJsonLayers["auth"];
		}
	}
	const modelsPath = join(baseDir, "models.json");
	ensureModelsResourceIds(modelsPath);
	const models = readJsonFile(modelsPath);
	if (models !== undefined) {
		layer.models = models;
	}
	const settings = readJsonFile(join(baseDir, "settings.json"));
	if (settings !== undefined) {
		layer.settings = settings;
	}
	const mcpPath = join(baseDir, "mcp.json");
	ensureMcpResourceIds(mcpPath);
	const mcp = readJsonFile(mcpPath);
	if (mcp !== undefined) {
		layer.mcp = mcp;
	}
	const contextFiles = readContextFiles(baseDir);
	if (contextFiles.length > 0) {
		layer.contextFiles = contextFiles;
	}
	const skills = readSkills(baseDir);
	if (skills.length > 0) {
		layer.skills = skills;
	}
	return Object.keys(layer).length > 0 ? layer : undefined;
}

function buildCwdLayer(cwd: string): PeerConfigJsonLayers | undefined {
	const layer = buildLayer(join(cwd, ".pi"), { includeAuth: false }) ?? {};
	const contextFiles = readContextFiles(cwd);
	if (contextFiles.length > 0) {
		layer.contextFiles = [...(layer.contextFiles ?? []), ...contextFiles];
	}
	return Object.keys(layer).length > 0 ? layer : undefined;
}

function mergeGlobalLayers(preferred: PeerConfigJsonLayers | undefined, fallback: PeerConfigJsonLayers | undefined) {
	if (!preferred) {
		return fallback;
	}
	if (!fallback) {
		return preferred;
	}
	const layer: PeerConfigJsonLayers = { ...fallback, ...preferred };
	if (fallback.auth || preferred.auth) {
		layer.auth = { ...(fallback.auth ?? {}), ...(preferred.auth ?? {}) };
	}
	if (!preferred.contextFiles && fallback.contextFiles) {
		layer.contextFiles = fallback.contextFiles;
	}
	if (!preferred.skills && fallback.skills) {
		layer.skills = fallback.skills;
	}
	return Object.keys(layer).length > 0 ? layer : undefined;
}

export function collectPeerConfigSnapshot(options: CollectPeerConfigSnapshotOptions = {}): PeerConfigSnapshot {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const globalDir = options.globalDir ?? dirname(agentDir);
	const global = mergeGlobalLayers(
		buildLayer(globalDir, { includeAuth: true }),
		buildLayer(agentDir, { includeAuth: true }),
	);
	return {
		version: 1,
		capturedAt: options.now?.() ?? new Date().toISOString(),
		cwd,
		global,
		cwdLayer: buildCwdLayer(cwd),
	};
}
