import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, loadSkillsFromDir } from "@sheason/pi-coding-agent";
import type {
	PeerConfigJsonLayers,
	PeerConfigSnapshot,
	PeerExtensionSnapshot,
	PeerPromptSnapshot,
	PeerThemeSnapshot,
} from "../../hub/index.js";

export interface CollectPeerConfigSnapshotOptions {
	cwd?: string;
	agentDir?: string;
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
	for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
		const path = join(dir, name);
		const content = readTextFile(path);
		if (content !== undefined) {
			out.push({ path, content });
			break;
		}
	}
	return out;
}

function readAncestorContextFiles(cwd: string): Array<{ path: string; content: string }> {
	const out: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();
	let currentDir = cwd;
	const root = resolve("/");

	while (true) {
		for (const file of readContextFiles(currentDir)) {
			if (!seenPaths.has(file.path)) {
				out.unshift(file);
				seenPaths.add(file.path);
			}
		}
		if (currentDir === root) break;
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
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

function readSystemFiles(dir: string): { systemPrompt?: string; appendSystemPrompt?: string[] } {
	const result: { systemPrompt?: string; appendSystemPrompt?: string[] } = {};
	const systemContent = readTextFile(join(dir, "SYSTEM.md"));
	if (systemContent !== undefined) {
		result.systemPrompt = systemContent;
	}
	const appendContent = readTextFile(join(dir, "APPEND_SYSTEM.md"));
	if (appendContent !== undefined) {
		result.appendSystemPrompt = [appendContent];
	}
	return result;
}

function readPrompts(dir: string): PeerPromptSnapshot[] {
	const promptsDir = join(dir, "prompts");
	if (!existsSync(promptsDir)) {
		return [];
	}
	const out: PeerPromptSnapshot[] = [];
	try {
		const entries = readdirSync(promptsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (!entry.name.endsWith(".md")) continue;
			const filePath = join(promptsDir, entry.name);
			const content = readTextFile(filePath);
			if (content === undefined) continue;
			out.push({ name: entry.name.replace(/\.md$/, ""), content, filePath });
		}
	} catch {
		// best-effort
	}
	return out;
}

function readThemes(dir: string): PeerThemeSnapshot[] {
	const themesDir = join(dir, "themes");
	if (!existsSync(themesDir)) {
		return [];
	}
	const out: PeerThemeSnapshot[] = [];
	try {
		const entries = readdirSync(themesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (!entry.name.endsWith(".json")) continue;
			const filePath = join(themesDir, entry.name);
			const content = readTextFile(filePath);
			if (content === undefined) continue;
			out.push({ name: entry.name.replace(/\.json$/, ""), content, filePath });
		}
	} catch {
		// best-effort
	}
	return out;
}

function readExtensions(dir: string): PeerExtensionSnapshot[] {
	const extensionsDir = join(dir, "extensions");
	if (!existsSync(extensionsDir)) {
		return [];
	}
	const out: PeerExtensionSnapshot[] = [];
	try {
		const entries = readdirSync(extensionsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
			const filePath = join(extensionsDir, entry.name);
			const content = readTextFile(filePath);
			if (content === undefined) continue;
			out.push({ name: entry.name.replace(/\.(ts|js)$/, ""), content, filePath });
		}
	} catch {
		// best-effort
	}
	return out;
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
	const systemFiles = readSystemFiles(baseDir);
	if (systemFiles.systemPrompt !== undefined) {
		layer.systemPrompt = systemFiles.systemPrompt;
	}
	if (systemFiles.appendSystemPrompt !== undefined) {
		layer.appendSystemPrompt = systemFiles.appendSystemPrompt;
	}
	const prompts = readPrompts(baseDir);
	if (prompts.length > 0) {
		layer.prompts = prompts;
	}
	const themes = readThemes(baseDir);
	if (themes.length > 0) {
		layer.themes = themes;
	}
	const extensions = readExtensions(baseDir);
	if (extensions.length > 0) {
		layer.extensions = extensions;
	}
	return Object.keys(layer).length > 0 ? layer : undefined;
}

function buildCwdLayer(cwd: string): PeerConfigJsonLayers | undefined {
	const layer = buildLayer(join(cwd, ".pi"), { includeAuth: false }) ?? {};
	const contextFiles = readAncestorContextFiles(cwd);
	if (contextFiles.length > 0) {
		layer.contextFiles = [...(layer.contextFiles ?? []), ...contextFiles];
	}
	return Object.keys(layer).length > 0 ? layer : undefined;
}

export function collectPeerConfigSnapshot(options: CollectPeerConfigSnapshotOptions = {}): PeerConfigSnapshot {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const global = buildLayer(agentDir, { includeAuth: true });
	return {
		version: 1,
		capturedAt: options.now?.() ?? new Date().toISOString(),
		cwd,
		global,
		cwdLayer: buildCwdLayer(cwd),
	};
}
