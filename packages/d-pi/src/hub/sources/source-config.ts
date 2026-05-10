import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHILD_AGENT_DIR_NAME, getSourcesConfigPath } from "../config.js";
import { ensureSourceResourceIds } from "../resource-ids.js";
import type { ChildSourceExtends, HostResourceSelection, SourceConfig, SourceTransport } from "./source-types.js";

export { getSourcesConfigPath } from "../config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseTransport(value: unknown): SourceTransport {
	if (value === "stdio") {
		return "stdio";
	}
	throw new Error(`Invalid source transport: expected "stdio", got ${JSON.stringify(value)}`);
}

function parseEnv(value: unknown): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error("Invalid source env: expected an object of string keys and string values");
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== "string") {
			throw new Error(`Invalid source env value for ${JSON.stringify(k)}: expected string`);
		}
		out[k] = v;
	}
	return out;
}

function parseHostResourceSelection(value: unknown, field: string): HostResourceSelection | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true) {
		return true;
	}
	if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
		return value;
	}
	throw new Error(`Invalid sources extends ${field}: expected true or an array of non-empty strings`);
}

function parseChildSourceExtends(value: unknown): ChildSourceExtends | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error('Invalid sources config: "extends" must be an object');
	}
	const host = value.host;
	if (host === undefined) {
		return undefined;
	}
	if (!isRecord(host)) {
		throw new Error('Invalid sources extends: "host" must be an object');
	}
	const sources = parseHostResourceSelection(host.sources, "host.sources");
	if (sources === undefined) {
		return { host: {} };
	}
	return { host: { sources } };
}

function parseSourceEntry(raw: unknown, index: number): SourceConfig {
	if (!isRecord(raw)) {
		throw new Error(`Invalid source entry at index ${index}: expected object`);
	}
	const name = raw.name;
	if (!isNonEmptyString(name)) {
		throw new Error(`Invalid source entry at index ${index}: "name" must be a non-empty string`);
	}
	const resourceId = raw.resourceId;
	if (!isNonEmptyString(resourceId)) {
		throw new Error(`Invalid source entry at index ${index}: "resourceId" must be a non-empty string`);
	}
	const transport = parseTransport(raw.transport);
	const command = raw.command;
	if (!isNonEmptyString(command)) {
		throw new Error(`Invalid source for ${JSON.stringify(name)}: "command" must be a non-empty string`);
	}
	let args: string[] | undefined;
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
			throw new Error(`Invalid source for ${JSON.stringify(name)}: "args" must be an array of strings`);
		}
		args = raw.args;
	}
	let cwd: string | undefined;
	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== "string") {
			throw new Error(`Invalid source for ${JSON.stringify(name)}: "cwd" must be a string`);
		}
		cwd = raw.cwd;
	}
	const env = parseEnv(raw.env);
	let agentId: string | undefined;
	if (raw.agentId !== undefined) {
		if (typeof raw.agentId !== "string") {
			throw new Error(`Invalid source for ${JSON.stringify(name)}: "agentId" must be a non-empty string`);
		}
		const trimmed = raw.agentId.trim();
		if (trimmed.length === 0) {
			throw new Error(`Invalid source for ${JSON.stringify(name)}: "agentId" must be a non-empty string`);
		}
		agentId = trimmed === "main" ? "root" : trimmed;
	}
	let disabled: boolean | undefined;
	if (raw.disabled !== undefined) {
		if (raw.disabled !== true && raw.disabled !== false) {
			throw new Error(`Invalid source for ${JSON.stringify(name)}: "disabled" must be a boolean`);
		}
		disabled = raw.disabled;
	}
	const out: SourceConfig = { resourceId, name, transport, command };
	if (args !== undefined) {
		out.args = args;
	}
	if (cwd !== undefined) {
		out.cwd = cwd;
	}
	if (env !== undefined) {
		out.env = env;
	}
	if (agentId !== undefined) {
		out.agentId = agentId;
	}
	if (disabled !== undefined) {
		out.disabled = disabled;
	}
	return out;
}

function normalizeSourcesList(parsed: unknown): unknown[] {
	if (Array.isArray(parsed)) {
		return parsed;
	}
	if (isRecord(parsed)) {
		if (parsed.sources === undefined) {
			return [];
		}
		if (!Array.isArray(parsed.sources)) {
			throw new Error('Invalid sources config: "sources" must be an array');
		}
		return parsed.sources;
	}
	throw new Error('Invalid sources config: root must be a JSON array of sources, or an object with a "sources" array');
}

function attachSourceConfigMetadata(source: SourceConfig, configPath: string, configResourceId: string): SourceConfig {
	Object.defineProperties(source, {
		configPath: { value: configPath, enumerable: false, configurable: true },
		configResourceId: { value: configResourceId, enumerable: false, configurable: true },
	});
	return source;
}

export function loadSourcesConfigFromPath(path: string): SourceConfig[] {
	if (!existsSync(path)) {
		return [];
	}
	ensureSourceResourceIds(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to parse sources config at ${path}: ${msg}`);
	}
	const sourcesRaw = normalizeSourcesList(parsed);
	const sources = overwriteDuplicateResourceIds(sourcesRaw.map((entry, i) => parseSourceEntry(entry, i))).map(
		(source) => attachSourceConfigMetadata(source, path, source.resourceId),
	);
	const seen = new Set<string>();
	for (const s of sources) {
		if (seen.has(s.name)) {
			throw new Error(`Duplicate source name ${JSON.stringify(s.name)}`);
		}
		seen.add(s.name);
	}
	return sources;
}

function overwriteDuplicateResourceIds(sources: SourceConfig[]): SourceConfig[] {
	const byResourceId = new Map<string, SourceConfig>();
	for (const source of sources) {
		byResourceId.set(source.resourceId, source);
	}
	return [...byResourceId.values()];
}

export interface LoadChildSourcesConfigResult {
	sources: SourceConfig[];
	extends?: ChildSourceExtends;
}

export function loadChildSourcesConfigFromPath(path: string): LoadChildSourcesConfigResult {
	if (!existsSync(path)) {
		return { sources: [] };
	}
	ensureSourceResourceIds(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to parse child sources config at ${path}: ${msg}`);
	}
	const sourcesRaw = normalizeSourcesList(parsed);
	const sources = overwriteDuplicateResourceIds(sourcesRaw.map((entry, i) => parseSourceEntry(entry, i))).map(
		(source) => attachSourceConfigMetadata(source, path, source.resourceId),
	);
	const ext = isRecord(parsed) ? parseChildSourceExtends(parsed.extends) : undefined;
	return ext === undefined ? { sources } : { sources, extends: ext };
}

function selectionIncludes(selection: HostResourceSelection | undefined, name: string): boolean {
	if (selection === true) {
		return true;
	}
	return Array.isArray(selection) && selection.includes(name);
}

function childSourceResourceId(agentId: string, resourceId: string): string {
	return `${agentId}:${resourceId}`;
}

export function loadSourcesConfigForAgents(cwd: string, childAgentIds: string[]): SourceConfig[] {
	const hostSources = loadSourcesConfig(cwd);
	const out: SourceConfig[] = [...hostSources];
	for (const agentId of childAgentIds) {
		const childPath = join(cwd, CHILD_AGENT_DIR_NAME, agentId, "sources.json");
		const child = loadChildSourcesConfigFromPath(childPath);
		const selection = child.extends?.host?.sources;
		for (const source of hostSources) {
			if (
				(source.agentId !== undefined && source.agentId !== "root" && source.agentId !== "main") ||
				!selectionIncludes(selection, source.name)
			) {
				continue;
			}
			out.push(
				attachSourceConfigMetadata(
					{
						...source,
						resourceId: childSourceResourceId(agentId, source.resourceId),
						agentId,
					},
					source.configPath ?? getSourcesConfigPath(cwd),
					source.configResourceId ?? source.resourceId,
				),
			);
		}
		for (const source of child.sources) {
			out.push(
				attachSourceConfigMetadata(
					{
						...source,
						resourceId: childSourceResourceId(agentId, source.resourceId),
						agentId: source.agentId ?? agentId,
					},
					source.configPath ?? childPath,
					source.configResourceId ?? source.resourceId,
				),
			);
		}
	}
	return out;
}

export function loadSourcesConfig(cwd: string): SourceConfig[] {
	return loadSourcesConfigFromPath(getSourcesConfigPath(cwd));
}
