import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLocalPiDir } from "../config.js";
import { ensureMcpResourceIds } from "../resource-ids.js";
import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig, McpTransport } from "./types.js";

export function getMcpConfigPath(cwd: string): string {
	return join(getLocalPiDir(cwd), "mcp.json");
}

export type McpConfigWrapperKind = "array" | "object";

export type ParseMcpConfigResult =
	| { ok: true; servers: McpServerConfig[]; wrapper: McpConfigWrapperKind }
	| { ok: false; error: string };

export type ReadMcpConfigResult = ParseMcpConfigResult;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function mcpNameErrorMessage(name: string): string | undefined {
	if (!MCP_NAME_PATTERN.test(name)) {
		return `Invalid MCP server name ${JSON.stringify(name)}: must match ^[a-zA-Z0-9_-]+$`;
	}
	if (name.includes("__")) {
		return `Invalid MCP server name ${JSON.stringify(name)}: must not contain "__"`;
	}
	return undefined;
}

function parseStringMap(
	value: unknown,
	field: string,
	serverName: string,
): { ok: true; map: Record<string, string> | undefined } | { ok: false; error: string } {
	if (value === undefined) {
		return { ok: true, map: undefined };
	}
	if (!isRecord(value)) {
		return {
			ok: false,
			error: `Invalid MCP server ${JSON.stringify(serverName)}: "${field}" must be an object of string keys and string values`,
		};
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== "string") {
			return {
				ok: false,
				error: `Invalid MCP server ${JSON.stringify(serverName)}: "${field}" value for ${JSON.stringify(k)}: expected string`,
			};
		}
		out[k] = v;
	}
	return { ok: true, map: out };
}

function parseTransport(value: unknown): { ok: true; transport: McpTransport } | { ok: false; error: string } {
	if (value === "stdio") {
		return { ok: true, transport: "stdio" };
	}
	if (value === "http") {
		return { ok: true, transport: "http" };
	}
	return {
		ok: false,
		error: `Invalid MCP transport: expected "stdio" or "http", got ${JSON.stringify(value)}`,
	};
}

function parseTimeoutMs(value: unknown, owner: string): number | string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		return `Invalid MCP ${owner}: "timeoutMs" must be a positive integer`;
	}
	return value;
}

function parseMcpEntry(raw: unknown, index: number, defaultTimeoutMs?: number): McpServerConfig | string {
	if (!isRecord(raw)) {
		return `Invalid MCP entry at index ${index}: expected object`;
	}
	const name = raw.name;
	if (!isNonEmptyString(name)) {
		return `Invalid MCP entry at index ${index}: "name" must be a non-empty string`;
	}
	const resourceId = isNonEmptyString(raw.resourceId) ? raw.resourceId : name;
	const nameErr = mcpNameErrorMessage(name);
	if (nameErr) {
		return nameErr;
	}
	const tr = parseTransport(raw.transport);
	if (!tr.ok) {
		return `Invalid MCP entry at index ${index}: ${tr.error}`;
	}
	let disabled: boolean | undefined;
	if (raw.disabled !== undefined) {
		if (raw.disabled !== true && raw.disabled !== false) {
			return `Invalid MCP server ${JSON.stringify(name)}: "disabled" must be a boolean`;
		}
		disabled = raw.disabled;
	}
	const parsedTimeoutMs = parseTimeoutMs(raw.timeoutMs, `server ${JSON.stringify(name)}`);
	if (typeof parsedTimeoutMs === "string") {
		return parsedTimeoutMs;
	}
	const timeoutMs = parsedTimeoutMs ?? defaultTimeoutMs;
	if (tr.transport === "stdio") {
		const command = raw.command;
		if (!isNonEmptyString(command)) {
			return `Invalid MCP server ${JSON.stringify(name)}: "command" must be a non-empty string`;
		}
		let args: string[] | undefined;
		if (raw.args !== undefined) {
			if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
				return `Invalid MCP server ${JSON.stringify(name)}: "args" must be an array of strings`;
			}
			args = raw.args;
		}
		let cwd: string | undefined;
		if (raw.cwd !== undefined) {
			if (typeof raw.cwd !== "string") {
				return `Invalid MCP server ${JSON.stringify(name)}: "cwd" must be a string`;
			}
			cwd = raw.cwd;
		}
		const envResult = parseStringMap(raw.env, "env", name);
		if (!envResult.ok) {
			return envResult.error;
		}
		const out: McpStdioServerConfig = { resourceId, name, transport: "stdio", command };
		if (timeoutMs !== undefined) {
			out.timeoutMs = timeoutMs;
		}
		if (args !== undefined) {
			out.args = args;
		}
		if (cwd !== undefined) {
			out.cwd = cwd;
		}
		if (envResult.map !== undefined) {
			out.env = envResult.map;
		}
		if (disabled !== undefined) {
			out.disabled = disabled;
		}
		return out;
	}
	const url = raw.url;
	if (!isNonEmptyString(url)) {
		return `Invalid MCP server ${JSON.stringify(name)}: "url" must be a non-empty string`;
	}
	const headersResult = parseStringMap(raw.headers, "headers", name);
	if (!headersResult.ok) {
		return headersResult.error;
	}
	const out: McpHttpServerConfig = { resourceId, name, transport: "http", url };
	if (timeoutMs !== undefined) {
		out.timeoutMs = timeoutMs;
	}
	if (headersResult.map !== undefined) {
		out.headers = headersResult.map;
	}
	if (disabled !== undefined) {
		out.disabled = disabled;
	}
	return out;
}

function normalizeMcpList(
	parsed: unknown,
):
	| { ok: true; list: unknown[]; wrapper: McpConfigWrapperKind; defaultTimeoutMs?: number }
	| { ok: false; error: string } {
	if (Array.isArray(parsed)) {
		return { ok: true, list: parsed, wrapper: "array" };
	}
	if (isRecord(parsed)) {
		const parsedTimeoutMs = parseTimeoutMs(parsed.timeoutMs, "config");
		if (typeof parsedTimeoutMs === "string") {
			return { ok: false, error: parsedTimeoutMs };
		}
		if (parsed.servers === undefined) {
			return {
				ok: true,
				list: [],
				wrapper: "object",
				...(parsedTimeoutMs === undefined ? {} : { defaultTimeoutMs: parsedTimeoutMs }),
			};
		}
		if (!Array.isArray(parsed.servers)) {
			return { ok: false, error: 'Invalid mcp config: "servers" must be an array' };
		}
		return {
			ok: true,
			list: parsed.servers,
			wrapper: "object",
			...(parsedTimeoutMs === undefined ? {} : { defaultTimeoutMs: parsedTimeoutMs }),
		};
	}
	return {
		ok: false,
		error: 'Invalid mcp config: root must be a JSON array of servers, or an object with a "servers" array',
	};
}

export function parseMcpConfig(parsed: unknown): ParseMcpConfigResult {
	const norm = normalizeMcpList(parsed);
	if (!norm.ok) {
		return { ok: false, error: norm.error };
	}
	const servers: McpServerConfig[] = [];
	for (let i = 0; i < norm.list.length; i++) {
		const r = parseMcpEntry(norm.list[i], i, norm.defaultTimeoutMs);
		if (typeof r === "string") {
			return { ok: false, error: r };
		}
		servers.push(r);
	}
	return { ok: true, servers: overwriteDuplicateResourceIds(servers), wrapper: norm.wrapper };
}

function overwriteDuplicateResourceIds(servers: McpServerConfig[]): McpServerConfig[] {
	const byResourceId = new Map<string, McpServerConfig>();
	for (const server of servers) {
		byResourceId.set(server.resourceId ?? server.name, server);
	}
	return [...byResourceId.values()];
}

export function readMcpConfig(cwd: string, configPath: string = getMcpConfigPath(cwd)): ReadMcpConfigResult {
	const path = configPath;
	if (!existsSync(path)) {
		return { ok: true, servers: [], wrapper: "array" };
	}
	try {
		ensureMcpResourceIds(path);
	} catch {
		// Let the parser below return the standard mcp.json parse error.
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `Failed to read mcp config at ${path}: ${msg}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `Failed to parse mcp config at ${path}: ${msg}` };
	}
	return parseMcpConfig(parsed);
}
