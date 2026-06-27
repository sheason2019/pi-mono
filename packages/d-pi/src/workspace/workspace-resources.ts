import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentLocalModelDefinition, AgentSourceDefinition } from "../agent-definition.ts";

const MODELS_DIR = "models";
const CONTEXT_DIR = "context";
const SOURCES_DIR = "sources";
const SOURCE_ENTRY = "source.ts";

const MODEL_EXTENSIONS = [".ts", ".js", ".mjs"];

export interface WorkspaceContextFile {
	key: string;
	path: string;
	content: string;
}

function scanModelFiles(dir: string, baseDir: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!existsSync(dir)) {
		return result;
	}
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			Object.assign(result, scanModelFiles(fullPath, baseDir));
		} else if (entry.isFile()) {
			const ext = extname(entry.name);
			if (!MODEL_EXTENSIONS.includes(ext)) {
				continue;
			}
			const relPath = relative(baseDir, fullPath);
			const key = relPath.replace(/\\/g, "/").replace(/\.(ts|js|mjs)$/, "");
			result[key] = fullPath;
		}
	}
	return result;
}

export function discoverWorkspaceModelPaths(workspaceRoot: string): Record<string, string> {
	const modelsDir = join(resolve(workspaceRoot), MODELS_DIR);
	return scanModelFiles(modelsDir, modelsDir);
}

function scanSourceDirs(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!existsSync(dir)) {
		return result;
	}
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const sourceDir = join(dir, entry.name);
		const sourceFile = join(sourceDir, SOURCE_ENTRY);
		if (existsSync(sourceFile) && statSync(sourceFile).isFile()) {
			result[entry.name] = sourceFile;
		}
	}
	return result;
}

export function discoverWorkspaceSourcePaths(workspaceRoot: string): Record<string, string> {
	const sourcesDir = join(resolve(workspaceRoot), SOURCES_DIR);
	return scanSourceDirs(sourcesDir);
}

export function discoverWorkspaceContextFiles(workspaceRoot: string): WorkspaceContextFile[] {
	const contextDir = join(resolve(workspaceRoot), CONTEXT_DIR);
	if (!existsSync(contextDir)) {
		return [];
	}
	const files: WorkspaceContextFile[] = [];
	const entries = readdirSync(contextDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		if (extname(entry.name) !== ".md") {
			continue;
		}
		const fullPath = join(contextDir, entry.name);
		const key = basename(entry.name, ".md");
		files.push({
			key,
			path: fullPath,
			content: readFileSync(fullPath, "utf-8"),
		});
	}
	return files;
}

export function resolveWorkspaceModelPath(workspaceRoot: string, modelRef: string): string | undefined {
	const modelsDir = join(resolve(workspaceRoot), MODELS_DIR);
	for (const ext of MODEL_EXTENSIONS) {
		const candidate = join(modelsDir, `${modelRef}${ext}`);
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}

export function resolveWorkspaceSourcePath(workspaceRoot: string, sourceName: string): string | undefined {
	const sourcesDir = join(resolve(workspaceRoot), SOURCES_DIR);
	const sourceFile = join(sourcesDir, sourceName, SOURCE_ENTRY);
	if (existsSync(sourceFile) && statSync(sourceFile).isFile()) {
		return sourceFile;
	}
	return undefined;
}

export async function loadWorkspaceModelDefinition(filePath: string): Promise<AgentLocalModelDefinition> {
	const resolved = resolve(filePath);
	const fileUrl = pathToFileURL(resolved);
	fileUrl.searchParams.set("mtime", String(Math.trunc(statSync(resolved).mtimeMs)));
	const mod = (await import(/* @vite-ignore */ fileUrl.href)) as { default?: unknown };
	if (!mod.default || typeof mod.default !== "object") {
		throw new Error(`Model file ${filePath} must export default defineModel({...})`);
	}
	return mod.default as AgentLocalModelDefinition;
}

export async function loadWorkspaceSourceDefinition(filePath: string): Promise<AgentSourceDefinition> {
	const resolved = resolve(filePath);
	const fileUrl = pathToFileURL(resolved);
	fileUrl.searchParams.set("mtime", String(Math.trunc(statSync(resolved).mtimeMs)));
	const mod = (await import(/* @vite-ignore */ fileUrl.href)) as { default?: unknown };
	if (!mod.default || typeof mod.default !== "object") {
		throw new Error(`Source file ${filePath} must export default defineSource({...})`);
	}
	return mod.default as AgentSourceDefinition;
}

export function ensureWorkspaceResourceDirs(workspaceRoot: string): void {
	const resolved = resolve(workspaceRoot);
	const modelsDir = join(resolved, MODELS_DIR);
	const contextDir = join(resolved, CONTEXT_DIR);
	const sourcesDir = join(resolved, SOURCES_DIR);
	if (!existsSync(modelsDir)) {
		mkdirSync(modelsDir, { recursive: true });
	}
	if (!existsSync(contextDir)) {
		mkdirSync(contextDir, { recursive: true });
	}
	if (!existsSync(sourcesDir)) {
		mkdirSync(sourcesDir, { recursive: true });
	}
}

export function isModelPathReference(model: unknown): model is string {
	return typeof model === "string";
}
