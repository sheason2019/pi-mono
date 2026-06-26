import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const AGENTS_MD = "AGENTS.md";
export const APPEND_SYSTEM_MD = "APPEND_SYSTEM.md";

export interface DPiContextFile {
	path: string;
	content: string;
}

export interface ResourceLoader {
	getSkills(): { skills: Array<{ name: string; filePath?: string }>; diagnostics: unknown[] };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getPrompts(): { prompts: unknown[]; diagnostics: unknown[] };
	getThemes(): { themes: unknown[]; diagnostics: unknown[] };
	getExtensions(): { extensions: unknown[]; errors: unknown[]; runtime: unknown };
	extendResources(resources: unknown): void;
	reload(): Promise<void>;
}

export function readTextFileIfExists(path: string): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	try {
		return readFileSync(resolvedPath, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read context resource ${resolvedPath}: ${message}`);
	}
}

export function readContextFileIfExists(path: string): DPiContextFile | undefined {
	const resolvedPath = resolve(path);
	const content = readTextFileIfExists(resolvedPath);
	if (content === undefined) {
		return undefined;
	}
	return { path: resolvedPath, content };
}

export function readContextFiles(paths: string[]): DPiContextFile[] {
	const files: DPiContextFile[] = [];
	for (const path of paths) {
		const file = readContextFileIfExists(path);
		if (file) {
			files.push(file);
		}
	}
	return files;
}

export function uniqueContextFiles(files: DPiContextFile[]): DPiContextFile[] {
	const seen = new Set<string>();
	const unique: DPiContextFile[] = [];
	for (const file of files) {
		const resolvedPath = resolve(file.path);
		if (seen.has(resolvedPath)) {
			continue;
		}
		seen.add(resolvedPath);
		unique.push({ path: resolvedPath, content: file.content });
	}
	return unique;
}

export function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		const resolvedValue = resolve(value);
		if (seen.has(resolvedValue)) {
			continue;
		}
		seen.add(resolvedValue);
		unique.push(resolvedValue);
	}
	return unique;
}

export function workspaceAgentsPath(workspaceRoot: string): string {
	return join(resolve(workspaceRoot), AGENTS_MD);
}

export function cwdAgentsPath(cwd: string): string {
	return join(resolve(cwd), AGENTS_MD);
}
