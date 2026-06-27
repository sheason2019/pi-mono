import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { AGENT_SWITCH_FILE } from "../multi-agent/index.ts";
import type { TeamSnapshot } from "../types.ts";
import { createConnectSession } from "./connect-auth.ts";

export interface DPiConnectOptions {
	url: string;
	agent?: string;
	authToken?: string;
	/**
	 * Path to the d-pi CLI entry used to spawn the TUI and executor
	 * children. Defaults to the current process's argv[1]. Set this when
	 * calling \`runDPiConnectMode\` as a library from a different entry
	 * point, so the children resolve to the right binary.
	 */
	cliPath?: string;
	/**
	 * Max time in ms for hub API calls during connect setup (team fetch,
	 * agent bind). Default 10_000. Without a bound, a down or unresponsive
	 * hub would make `d-pi connect` hang indefinitely.
	 */
	connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

interface DPiConnectRuntimeOptions {
	/** Optional fetch implementation for tests or embedded runtimes. */
	fetchImpl?: FetchLike;
	/** Optional connect id factory; defaults to crypto.randomUUID. */
	createConnectId?: () => string;
	/** Optional session runner for tests; defaults to spawning a real connect session. */
	runSession?: (opts: ConnectSessionSpawnOptions & { fetchImpl?: FetchLike }) => Promise<void>;
}

/** Options for spawning a connected session (TUI + executor). */
export interface ConnectSessionSpawnOptions {
	/** Path to the d-pi CLI entry (e.g. process.argv[1]). */
	cliPath: string;
	/** Resolved agent URL on the hub (e.g. http://hub/agents/<name>). */
	agentUrl: string;
	/** Base hub URL. */
	hubUrl: string;
	/** Bearer token, or undefined for unauthenticated dev. */
	authToken: string | undefined;
	/** Hub routing name for the connected agent. */
	agentName: string;
	/** Session-unique executor registry id. */
	connectId: string;
	/** Local cwd the executor should run in. */
	cwd: string;
	/** Timeout in ms for hub API calls (bind). Default 10_000. */
	connectTimeoutMs?: number;
}

/**
 * Run d-pi connect mode using a subprocess model.
 *
 * Spawns `d-pi _connect-child` (TUI) and `d-pi _executor-child` (tool runner)
 * as child processes. Both children share auth and lifecycle: if either dies,
 * the other is killed. The TUI renders directly in the terminal via
 * stdio:inherit. When the user selects a different agent via /agents, the TUI
 * writes the target agent name to AGENT_SWITCH_FILE and exits gracefully. The
 * parent detects the switch by checking for the file, then respawns a new
 * session connected to the selected agent.
 *
 * Before each spawn, the parent registers the agent→connectId binding with
 * the hub via POST /_hub/agents/{name}/bind so /agents/{name}/remote-call can be
 * dispatched to the executor.
 */
export async function runDPiConnectMode(
	options: DPiConnectOptions,
	runtime: DPiConnectRuntimeOptions = {},
): Promise<void> {
	const cliPath = options.cliPath ?? process.argv[1]!;
	const fetchImpl = runtime.fetchImpl ?? fetch;
	const createConnectId = runtime.createConnectId ?? (() => crypto.randomUUID());
	const runSession = runtime.runSession ?? runConnectSession;
	let { url } = options;
	let authToken = options.authToken;
	const { agent: agentSpec } = options;
	if (!authToken && url.includes("@")) {
		const session = await createConnectSession({ target: url });
		url = session.url;
		authToken = session.token;
	}
	const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;

	// 1. Fetch team from Hub to resolve initial agent
	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const networkResponse = await fetchWithTimeout(
		fetchImpl,
		`${url}/_hub/team`,
		{ headers },
		connectTimeoutMs,
		`Failed to reach hub at ${url}`,
	);
	if (!networkResponse.ok) {
		throw new Error(`Failed to fetch team: ${networkResponse.status} ${networkResponse.statusText}`);
	}
	const network = (await networkResponse.json()) as TeamSnapshot;

	let currentAgentName = resolveAgentName(network, agentSpec);

	// 2. Agent switching loop — each iteration spawns a fresh session
	while (true) {
		const agentUrl = `${url}/agents/${currentAgentName}`;

		await runSession({
			cliPath,
			agentUrl,
			hubUrl: url,
			authToken,
			agentName: currentAgentName,
			// Use a per-session UUID for connectId so multiple machines
			// can connect to the same agent concurrently without
			// colliding in the hub's ExecutorRegistry. The agent name
			// is still used for routing (it goes in the URL path
			// /agents/{name}/remote-call) and for the hub's
			// _agentBindings map, but the connectId — which is the
			// key for the executor registry — is session-unique.
			connectId: createConnectId(),
			cwd: process.cwd(),
			connectTimeoutMs,
			fetchImpl,
		});

		// Check if the child exited due to an agent switch (file exists)
		// vs a normal quit (file absent)
		if (existsSync(AGENT_SWITCH_FILE)) {
			try {
				const newAgentName = readFileSync(AGENT_SWITCH_FILE, "utf-8").trim();
				unlinkSync(AGENT_SWITCH_FILE);
				currentAgentName = newAgentName;
				// Clear terminal before spawning new child so previous session content is removed
				process.stdout.write("\x1B[2J\x1B[H");
				continue;
			} catch {
				// Failed to read switch file — fall through to exit
			}
		}

		// Normal quit or error — break out of the loop
		break;
	}
}

/** Build CLI args for the TUI connect child. */
export function buildConnectChildArgs(cliPath: string, agentUrl: string, hubUrl: string): string[] {
	if (cliPath.endsWith(".ts")) {
		return ["--import", "tsx", cliPath, "_connect-child", agentUrl, hubUrl];
	}
	return [cliPath, "_connect-child", agentUrl, hubUrl];
}

export interface RemoteTuiConnectSessionOptions {
	baseUrl: string;
	agentName: string;
	authHeaders?: Readonly<Record<string, string>>;
}

export function createRemoteTuiOptionsFromConnectSession(options: {
	agentUrl: string;
	hubUrl: string;
	authToken: string | undefined;
}): RemoteTuiConnectSessionOptions {
	const agentName = decodeURIComponent(new URL(options.agentUrl).pathname.split("/").filter(Boolean).at(-1) ?? "");
	const baseUrl = options.hubUrl.replace(/\/+$/, "");
	return {
		baseUrl,
		agentName,
		...(options.authToken === undefined ? {} : { authHeaders: { Authorization: `Bearer ${options.authToken}` } }),
	};
}

/** Build CLI args for the executor child. */
export function buildExecutorChildArgs(cliPath: string): string[] {
	if (cliPath.endsWith(".ts")) {
		return ["--import", "tsx", cliPath, "_executor-child"];
	}
	return [cliPath, "_executor-child"];
}

/** Minimal fetch shape used by the parent for hub bookkeeping. */
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Fetch with an AbortController-based timeout. Throws a clear error on
 * timeout or network failure so the CLI exits instead of hanging.
 */
async function fetchWithTimeout(
	fetchImpl: FetchLike,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	errorPrefix: string,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, { ...init, signal: controller.signal });
		clearTimeout(timer);
		return res;
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(
				`${errorPrefix}: connection timed out after ${timeoutMs}ms. The hub may be down or unreachable.`,
			);
		}
		throw new Error(`${errorPrefix}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const DPI_CHILD_ENV_KEYS = [
	"DPI_AUTH_TOKEN",
	"DPI_CONNECT_ID",
	"DPI_CURRENT_AGENT_NAME",
	"DPI_HUB_URL",
	"DPI_CWD",
] as const;

function createCleanDpiChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...source };
	for (const key of DPI_CHILD_ENV_KEYS) {
		delete env[key];
	}
	return env;
}

export function createExecutorChildEnv(
	options: Pick<ConnectSessionSpawnOptions, "hubUrl" | "authToken" | "connectId" | "cwd">,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = createCleanDpiChildEnv(source);
	env.DPI_HUB_URL = options.hubUrl;
	env.DPI_CONNECT_ID = options.connectId;
	env.DPI_CWD = options.cwd;
	if (options.authToken !== undefined) {
		env.DPI_AUTH_TOKEN = options.authToken;
	}
	return env;
}

export function createConnectChildEnv(
	options: Pick<ConnectSessionSpawnOptions, "hubUrl" | "authToken" | "agentName">,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = createCleanDpiChildEnv(source);
	env.DPI_HUB_URL = options.hubUrl;
	env.DPI_CURRENT_AGENT_NAME = options.agentName;
	if (options.authToken !== undefined) {
		env.DPI_AUTH_TOKEN = options.authToken;
	}
	return env;
}

/**
 * Bind an agent to a connect id on the hub. Idempotent; throws on failure.
 *
 * Until this returns, the hub will reject any /agents/{name}/remote-call with
 * 409 ("Agent not in connect mode"). We call this before spawning the
 * executor so the first remote call from the TUI can find its target.
 */
export async function bindAgentOnHub(
	hubUrl: string,
	authToken: string | undefined,
	agentName: string,
	connectId: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<void> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (authToken) headers.Authorization = `Bearer ${authToken}`;
	const encodedAgentName = encodeURIComponent(agentName);
	const res = await fetchWithTimeout(
		fetchImpl,
		`${hubUrl}/_hub/agents/${encodedAgentName}/bind`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ connectId }),
		},
		timeoutMs,
		`Failed to reach hub at ${hubUrl}`,
	);
	if (!res.ok) {
		throw new Error(`Failed to bind agent ${agentName} to connect ${connectId}: ${res.status} ${await res.text()}`);
	}
}

/**
 * Spawn one connect session: the TUI child plus the executor child, sharing
 * lifecycle. Resolves when either child exits. Cleans up the other child,
 * restores the terminal, and unbinds the agent on the hub.
 */
export async function runConnectSession(opts: ConnectSessionSpawnOptions & { fetchImpl?: FetchLike }): Promise<void> {
	const { cliPath, agentUrl, hubUrl, authToken, agentName, connectId, cwd } = opts;
	const fetchImpl = opts.fetchImpl ?? fetch;

	// 1. Register the agent→connectId binding on the hub.
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	await bindAgentOnHub(hubUrl, authToken, agentName, connectId, fetchImpl, connectTimeoutMs);

	// 2. Spawn executor + TUI in parallel.
	const execChild = spawn(process.execPath, buildExecutorChildArgs(cliPath), {
		stdio: ["ignore", "ignore", "ignore"],
		env: createExecutorChildEnv({ hubUrl, authToken, connectId, cwd }),
	});
	const tuiChild = spawn(process.execPath, buildConnectChildArgs(cliPath, agentUrl, hubUrl), {
		stdio: "inherit",
		env: createConnectChildEnv({ hubUrl, authToken, agentName }),
	});

	await new Promise<void>((resolve) => {
		let resolved = false;
		const finish = () => {
			if (resolved) return;
			resolved = true;
			// Best-effort cleanup of the surviving child.
			try {
				if (!tuiChild.killed) tuiChild.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			try {
				if (!execChild.killed) execChild.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			// Safety net: restore terminal state in case a child exited
			// abnormally without cleaning up. The TUI enables the Kitty
			// progressive keyboard protocol (CSI >u) and modifyOtherKeys
			// (CSI >4;1m) on start; its own `stop()` pops both, but when the
			// TUI is SIGTERM'd here it never reaches `stop()`, so the parent
			// has to pop them itself. Without this the shell inherits the
			// protocol and renders every keystroke as a `7;1:3u…` sequence.
			try {
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false);
				}
				process.stdout.write("\x1B[<u"); // Pop Kitty keyboard protocol
				process.stdout.write("\x1B[>4;0m"); // Disable modifyOtherKeys
				process.stdout.write("\x1B[?25h"); // Show cursor
				process.stdout.write("\x1B[?1004l"); // Disable focus reporting
				process.stdout.write("\x1B[?2004l"); // Disable bracketed paste
			} catch {
				// Ignore errors during terminal restore
			}
			resolve();
		};

		tuiChild.on("exit", () => {
			process.stderr.write(`[d-pi connect] TUI child exited\n`);
			finish();
		});
		execChild.on("exit", () => {
			process.stderr.write(`[d-pi connect] executor child exited\n`);
			finish();
		});
		tuiChild.on("error", (err) => {
			process.stderr.write(`[d-pi connect] Failed to spawn TUI child: ${err.message}\n`);
			finish();
		});
		execChild.on("error", (err) => {
			process.stderr.write(`[d-pi connect] Failed to spawn executor child: ${err.message}\n`);
			finish();
		});
	});

	// 3. Unbind so a future /agents/{name}/remote-call from a different session
	// does not hit a stale binding. Bounded by a short timeout: the hub has
	// its own GC of stale bindings on executor SSE close, so a slow unbind
	// is not load-bearing. Without this bound, a half-open TCP socket to a
	// dead hub can keep the parent alive past the moment the executor is
	// reaped, surfacing as a hang right after the "TUI child exited" line.
	try {
		const headers: Record<string, string> = {};
		if (authToken) headers.Authorization = `Bearer ${authToken}`;
		const encodedAgentName = encodeURIComponent(agentName);
		await Promise.race([
			fetchImpl(`${hubUrl}/_hub/agents/${encodedAgentName}/unbind`, { method: "POST", headers }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("unbind timeout")), 2_000)),
		]);
	} catch {
		// Unbind is best-effort; the hub will GC stale bindings on executor disconnect.
	}
}

/** Resolve agent name from spec (the only valid identifier now). */
function resolveAgentName(network: TeamSnapshot, agentSpec?: string): string {
	if (agentSpec) {
		const byName = network.agents.find((a) => a.name === agentSpec);
		if (byName) return byName.name;
		throw new Error(`Agent not found: ${agentSpec}. Available: ${network.agents.map((a) => a.name).join(", ")}`);
	}
	return network.rootName;
}
