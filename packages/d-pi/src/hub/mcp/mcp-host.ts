import type { ToolDefinition } from "@sheason/pi-coding-agent";
import type { HubLogDetails, HubLogSink } from "../tui/hub-log.js";
import { createMcpClient, type McpClientHandle } from "./mcp-client.js";
import { parseMcpConfig, readMcpConfig } from "./mcp-config.js";
import {
	pauseServer as persistPause,
	removeServer as persistRemove,
	restartServer as persistRestart,
} from "./mcp-config-writer.js";
import { wrapMcpServerAsToolDefinitions } from "./mcp-tool-bridge.js";
import type { McpCapabilitySummary, McpRuntimeStatus, McpServerConfig, McpTransport } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

type ClientEntry = { handle: McpClientHandle };

type ServerState = {
	transport: McpTransport;
	status: McpRuntimeStatus["status"];
	error?: string;
	capabilities: McpCapabilitySummary;
};

function emptyCapabilities(): McpCapabilitySummary {
	return { tools: [], resources: [], prompts: [] };
}

function mcpServerResourceId(config: McpServerConfig): string {
	return config.resourceId ?? config.name;
}

function logCloseError(e: unknown, name: string): void {
	const msg = e instanceof Error ? e.message : String(e);
	console.error(`McpHost: error closing client for ${JSON.stringify(name)}: ${msg}`);
}

/**
 * Synchronously removes all entries whose `name` starts with `mcp__` and returns them removed.
 * The shared `customTools` array is mutated in place; call sites must not `await` between
 * this step and re-appending new MCP tools.
 */
function removeMcpOwnedTools(customTools: ToolDefinition[]): void {
	let w = 0;
	for (let r = 0; r < customTools.length; r++) {
		const t = customTools[r];
		if (t && !t.name.startsWith("mcp__")) {
			customTools[w] = t;
			w++;
		}
	}
	customTools.length = w;
}

export interface McpHostOptions {
	cwd: string;
	customTools: ToolDefinition[];
	configPath?: string;
	configRoot?: () => unknown;
	timeoutMs?: number;
	createClient?: (config: McpServerConfig, opts: { timeoutMs: number }) => Promise<McpClientHandle>;
	logs?: HubLogSink;
}

type MutateOk = { ok: true; servers: McpRuntimeStatus[] };
type MutateErr = { ok: false; error: string };
type MutateResult = MutateOk | MutateErr;

export class McpHost {
	private readonly cwd: string;
	private readonly customTools: ToolDefinition[];
	private readonly configPath?: string;
	private readonly configRoot?: () => unknown;
	private readonly timeoutMs: number;
	private readonly createClient: (config: McpServerConfig, opts: { timeoutMs: number }) => Promise<McpClientHandle>;
	private readonly logs: HubLogSink | undefined;
	private _configError: string | undefined;
	/** From the last `readMcpConfig` that succeeded. Empty on parse failure or when file empty. */
	private orderedServers: McpServerConfig[] = [];
	/** State aligned with `orderedServers` order for `getStatuses()`. */
	private lastStates = new Map<string, ServerState>();
	private clients = new Map<string, ClientEntry>();
	/** In-flight `restart()`: all concurrent callers share one stop+start cycle. */
	private _restartInFlight: Promise<void> | undefined;

	constructor(options: McpHostOptions) {
		this.cwd = options.cwd;
		this.customTools = options.customTools;
		this.configPath = options.configPath;
		this.configRoot = options.configRoot;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.createClient = options.createClient ?? createMcpClient;
		this.logs = options.logs;
	}

	private log(level: keyof HubLogSink, message: string, details?: HubLogDetails): void {
		try {
			this.logs?.[level](message, details);
		} catch {
			// Logging must never break MCP startup.
		}
	}

	/**
	 * The shared `ToolDefinition[]` from construction (mutated by this host; same
	 * instance as the hub / agent `customTools` array when wired from `HubRuntime`).
	 */
	getSharedCustomToolsArray(): ToolDefinition[] {
		return this.customTools;
	}

	/** Populated when `mcp.json` is missing or not valid JSON, or the parser fails. */
	getConfigError(): string | undefined {
		return this._configError;
	}

	getStatuses(): McpRuntimeStatus[] {
		if (this._configError !== undefined && this.orderedServers.length === 0) {
			return [];
		}
		const out: McpRuntimeStatus[] = [];
		for (const c of this.orderedServers) {
			const resourceId = mcpServerResourceId(c);
			const s = this.lastStates.get(resourceId);
			if (!s) {
				const row: McpRuntimeStatus = {
					resourceId,
					name: c.name,
					transport: c.transport,
					status: "stopped",
					capabilities: emptyCapabilities(),
				};
				if (c.disabled === true) {
					row.disabled = true;
				}
				out.push(row);
				continue;
			}
			const row: McpRuntimeStatus = {
				resourceId,
				name: c.name,
				transport: c.transport,
				status: s.status,
				capabilities: s.capabilities,
			};
			if (s.error !== undefined) {
				row.error = s.error;
			}
			if (c.disabled === true) {
				row.disabled = true;
			}
			out.push(row);
		}
		return out;
	}

	/**
	 * `stop()` + `start()` in sequence. Concurrent callers await the same in-flight
	 * operation so the host does not interleave `close` and `connect` for multiple cycles.
	 */
	async restart(): Promise<void> {
		if (this._restartInFlight) {
			await this._restartInFlight;
			return;
		}
		const run = (async () => {
			try {
				await this.stop();
				await this.start();
			} finally {
				this._restartInFlight = undefined;
			}
		})();
		this._restartInFlight = run;
		await run;
	}

	async stop(): Promise<void> {
		for (const [resourceId, entry] of this.clients) {
			try {
				await entry.handle.close();
			} catch (e) {
				logCloseError(e, resourceId);
			}
		}
		this.clients.clear();
		removeMcpOwnedTools(this.customTools);
		for (const c of this.orderedServers) {
			const resourceId = mcpServerResourceId(c);
			const st = this.lastStates.get(resourceId);
			if (st) {
				this.lastStates.set(resourceId, {
					...st,
					status: "stopped",
					error: undefined,
					capabilities: emptyCapabilities(),
				});
			} else {
				this.lastStates.set(resourceId, {
					transport: c.transport,
					status: "stopped",
					capabilities: emptyCapabilities(),
				});
			}
		}
	}

	async start(): Promise<void> {
		for (const [resourceId, entry] of this.clients) {
			try {
				await entry.handle.close();
			} catch (e) {
				logCloseError(e, resourceId);
			}
		}
		this.clients.clear();
		this.lastStates.clear();
		this._configError = undefined;
		this.orderedServers = [];

		const read = this.configRoot ? parseMcpConfig(this.configRoot()) : readMcpConfig(this.cwd, this.configPath);
		if (!read.ok) {
			this._configError = read.error;
			this.log("warning", "mcp config error", { error: read.error });
			removeMcpOwnedTools(this.customTools);
			return;
		}
		this.orderedServers = read.servers;

		if (this.orderedServers.length === 0) {
			removeMcpOwnedTools(this.customTools);
			return;
		}

		for (const c of this.orderedServers) {
			if (c.disabled === true) {
				this.lastStates.set(mcpServerResourceId(c), {
					transport: c.transport,
					status: "stopped",
					capabilities: emptyCapabilities(),
				});
			}
		}

		const toConnect: McpServerConfig[] = [];
		for (const c of this.orderedServers) {
			if (c.disabled !== true) {
				toConnect.push(c);
			}
		}

		const results = await Promise.allSettled(
			toConnect.map((cfg) => this.createClient(cfg, { timeoutMs: cfg.timeoutMs ?? this.timeoutMs })),
		);
		const newMcpTools: ToolDefinition[] = [];
		for (let i = 0; i < toConnect.length; i++) {
			const cfg = toConnect[i]!;
			const resourceId = mcpServerResourceId(cfg);
			const settled = results[i]!;
			if (settled.status === "rejected") {
				const err = settled.reason;
				const msg = err instanceof Error ? err.message : String(err);
				this.log("error", "mcp server error", {
					mcpServer: cfg.name,
					resourceId,
					transport: cfg.transport,
					timeoutMs: cfg.timeoutMs ?? this.timeoutMs,
					error: msg,
				});
				this.lastStates.set(resourceId, {
					transport: cfg.transport,
					status: "error",
					error: msg,
					capabilities: emptyCapabilities(),
				});
				continue;
			}
			const handle = settled.value;
			this.clients.set(resourceId, { handle });
			this.lastStates.set(resourceId, {
				transport: cfg.transport,
				status: "running",
				capabilities: handle.capabilities,
			});
			const { tools: wrapped } = wrapMcpServerAsToolDefinitions(resourceId, handle);
			for (const t of wrapped) {
				newMcpTools.push(t);
			}
		}

		removeMcpOwnedTools(this.customTools);
		for (const t of newMcpTools) {
			this.customTools.push(t);
		}
	}

	private requireKnownServerInConfigOrFail(resourceId: string): MutateResult | null {
		const read = this.configRoot ? parseMcpConfig(this.configRoot()) : readMcpConfig(this.cwd, this.configPath);
		if (!read.ok) {
			return { ok: false, error: read.error };
		}
		if (!read.servers.some((s) => mcpServerResourceId(s) === resourceId)) {
			return { ok: false, error: `Unknown MCP server resourceId: ${JSON.stringify(resourceId)}` };
		}
		return null;
	}

	async pauseServer(resourceId: string): Promise<MutateResult> {
		const pre = this.requireKnownServerInConfigOrFail(resourceId);
		if (pre) {
			return pre;
		}
		const w = persistPause(this.cwd, resourceId, this.configPath);
		if (!w.ok) {
			return w;
		}
		await this.restart();
		return { ok: true, servers: this.getStatuses() };
	}

	async restartServer(resourceId: string): Promise<MutateResult> {
		const pre = this.requireKnownServerInConfigOrFail(resourceId);
		if (pre) {
			return pre;
		}
		const w = persistRestart(this.cwd, resourceId, this.configPath);
		if (!w.ok) {
			return w;
		}
		await this.restart();
		return { ok: true, servers: this.getStatuses() };
	}

	async removeServer(resourceId: string): Promise<MutateResult> {
		const pre = this.requireKnownServerInConfigOrFail(resourceId);
		if (pre) {
			return pre;
		}
		const w = persistRemove(this.cwd, resourceId, this.configPath);
		if (!w.ok) {
			return w;
		}
		await this.restart();
		return { ok: true, servers: this.getStatuses() };
	}
}
