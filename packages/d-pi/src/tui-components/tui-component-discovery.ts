import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTuiComponentDefinition } from "./tui-component-definition.ts";

const TUI_COMPONENTS_DIR = "tui-components";

export interface TuiComponentFile {
	name: string;
	path: string;
}

export function tuiComponentsDir(workspaceRoot: string): string {
	return join(resolve(workspaceRoot), TUI_COMPONENTS_DIR);
}

export function discoverTuiComponentFiles(workspaceRoot: string): TuiComponentFile[] {
	const dir = tuiComponentsDir(workspaceRoot);
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function isAgentTuiComponentDefinition(value: unknown): value is AgentTuiComponentDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { customType?: unknown }).customType === "string" &&
		typeof (value as { render?: unknown }).render === "function"
	);
}

export async function loadTuiComponentDefinitionFromFile(path: string): Promise<AgentTuiComponentDefinition> {
	const module = (await import(/* @vite-ignore */ pathToFileURL(resolve(path)).href)) as { default?: unknown };
	if (!isAgentTuiComponentDefinition(module.default)) {
		throw new TypeError(`TUI component file must default export defineTuiComponent(...): ${path}`);
	}
	return module.default;
}
