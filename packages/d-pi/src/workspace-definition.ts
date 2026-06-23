import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentModelDefinition } from "./agent-definition.ts";

export type SourceOutput = (data: string) => void;

export interface SourceContext {
	signal: AbortSignal;
	workspaceRoot: string;
	name: string;
}

export interface SourceDefinition {
	execute(output: SourceOutput, context: SourceContext): Promise<void> | void;
	description?: string;
	readonly name?: string;
}

export interface WorkspaceDefinitionInput {
	models?: Record<string, AgentModelDefinition>;
	sources?: Record<string, SourceDefinition>;
}

export interface WorkspaceDefinition {
	models: Record<string, AgentModelDefinition>;
	sources: Record<string, SourceDefinition>;
}

const WORKSPACE_TS_FILE = "d-pi.ts";

export function defineSource(input: SourceDefinition): SourceDefinition {
	if (typeof input.execute !== "function") {
		throw new TypeError("defineSource requires an execute function");
	}
	return {
		execute: input.execute,
		...(input.description === undefined ? {} : { description: input.description }),
	};
}

export function defineWorkspace(input: WorkspaceDefinitionInput): WorkspaceDefinition {
	const models = input.models ?? {};
	const sources = input.sources ?? {};
	if (Array.isArray(models)) {
		throw new TypeError("Workspace models must be an object");
	}
	if (Array.isArray(sources)) {
		throw new TypeError("Workspace sources must be an object");
	}
	for (const key of Object.keys(models)) {
		if (!key.includes("/")) {
			throw new TypeError(`Workspace model key must use provider/model format: ${key}`);
		}
	}
	const normalizedSources: Record<string, SourceDefinition> = {};
	for (const [key, source] of Object.entries(sources)) {
		if (!key.trim()) {
			throw new TypeError("Workspace source key must be non-empty");
		}
		const normalized = defineSource(source);
		Object.defineProperty(normalized, "name", {
			value: key,
			enumerable: false,
			configurable: true,
		});
		normalizedSources[key] = normalized;
	}
	return { models: { ...models }, sources: normalizedSources };
}

function isWorkspaceDefinition(value: unknown): value is WorkspaceDefinitionInput {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadWorkspaceDefinitionFromFile(path: string): Promise<WorkspaceDefinition> {
	const resolvedPath = resolve(path);
	const url = pathToFileURL(resolvedPath);
	url.searchParams.set("mtime", String(Math.trunc(statSync(resolvedPath).mtimeMs)));
	const module = (await import(/* @vite-ignore */ url.href)) as { default?: unknown };
	if (!isWorkspaceDefinition(module.default)) {
		throw new TypeError("Workspace file must default export defineWorkspace(...)");
	}
	return defineWorkspace(module.default);
}

export async function readWorkspaceDefinitionFromTs(workspaceRoot: string): Promise<WorkspaceDefinition | undefined> {
	const filePath = join(resolve(workspaceRoot), WORKSPACE_TS_FILE);
	if (!existsSync(filePath)) {
		return undefined;
	}
	return loadWorkspaceDefinitionFromFile(filePath);
}
