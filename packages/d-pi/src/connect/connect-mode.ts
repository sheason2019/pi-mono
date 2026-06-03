import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { AGENT_SWITCH_FILE } from "../extension/index.ts";
import type { AgentNetworkSnapshot } from "../types.ts";
import { createConnectSession } from "./connect-auth.ts";

export interface DPiConnectOptions {
	url: string;
	agent?: string;
	authToken?: string;
}

/** Options for spawning a connected session (TUI + executor). */
export interface ConnectSessionSpawnOptions {
	/** Path to the d-pi CLI entry (e.g. process.argv[1]). */
	cliPath: string;
	/** Resolved agent URL on the hub (e.g. http://hub/agents/<id>). */
	agentUrl: string;
	/** Base hub URL. */
	hubUrl: string;
	/** Bearer token, or undefined for unauthenticated dev. */
	authToken: string | undefined;
	/** Connect id (= agent id for now). */
	connectId: string;
	/** Local cwd the executor should run in. */
	cwd: string;
}

/**
 * Run d-pi connect mode using a subprocess model.
 *
 * Spawns `d-pi _connect-child` (TUI) and `d-pi _executor-child` (tool runner)
 * as child processes. Both children share auth and lifecycle: if either dies,
 * the other is killed. The TUI renders directly in the terminal via
 * stdio:inherit. When the user selects a different agent via /agents, the TUI
 * writes the target agent ID to AGENT_SWITCH_FILE and exits gracefully. The
 * parent detects the switch by checking for the file, then respawns a new
 * session connected to the selected agent.
 *
 * Before each spawn, the parent registers the agent→connectId binding with
 * the hub via POST /_hub/agents/{id}/bind so /agents/{id}/remote-call can be
 * dispatched to the executor.
 */
export async function runDPiConnectMode(options: DPiConnectOptions): Promise<void> {
	let { url } = options;
	let authToken = options.authToken;
	const { agent: agentSpec } = options;
	if (!authToken && url.includes("@")) {
		const session = await createConnectSession({ target: url });
		url = session.url;
		authToken = session.token;
	}
	const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;

	// 1. Fetch agent network from Hub to resolve initial agent
	const networkResponse = await fetch(`${url}/_hub/network`, { headers });
	if (!networkResponse.ok) {
		throw new Error(`Failed to fetch agent network: ${networkResponse.status} ${networkResponse.statusText}`);
	}
	const network = (await networkResponse.json()) as AgentNetworkSnapshot;

	let currentAgentId = resolveAgentId(network, agentSpec);

	// 2. Agent switching loop — each iteration spawns a fresh session
	while (true) {
		const agentUrl = `${url}/agents/${currentAgentId}`;

		await runConnectSession({
			cliPath: process.argv[1]!,
			agentUrl,
			hubUrl: url,
			authToken,
			connectId: currentAgentId,
			cwd: process.cwd(),
			fetchImpl: fetch,
		});

		// Check if the child exited due to an agent switch (file exists)
		// vs a normal quit (file absent)
		if (existsSync(AGENT_SWITCH_FILE)) {
			try {
				const newAgentId = readFileSync(AGENT_SWITCH_FILE, "utf-8").trim();
				unlinkSync(AGENT_SWITCH_FILE);
				currentAgentId = newAgentId;
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

/** Build CLI args for the executor child. */
export function buildExecutorChildArgs(cliPath: string): string[] {
	if (cliPath.endsWith(".ts")) {
		return ["--import", "tsx", cliPath, "_executor-child"];
	}
	return [cliPath, "_executor-child"];
}

/** Minimal fetch shape used by the parent for hub bookkeeping. */
type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Bind an agent to a connect id on the hub. Idempotent; throws on failure.
 *
 * Until this returns, the hub will reject any /agents/{id}/remote-call with
 * 409 ("Agent not in connect mode"). We call this before spawning the
 * executor so the first remote call from the TUI can find its target.
 */
export async function bindAgentOnHub(
	hubUrl: string,
	authToken: string | undefined,
	agentId: string,
	connectId: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (authToken) headers.Authorization = `Bearer ${authToken}`;
	const res = await fetchImpl(`${hubUrl}/_hub/agents/${agentId}/bind`, {
		method: "POST",
		headers,
		body: JSON.stringify({ connectId }),
	});
	if (!res.ok) {
		throw new Error(`Failed to bind agent ${agentId} to connect ${connectId}: ${res.status} ${await res.text()}`);
	}
}

/**
 * Spawn one connect session: the TUI child plus the executor child, sharing
 * lifecycle. Resolves when either child exits. Cleans up the other child,
 * restores the terminal, and unbinds the agent on the hub.
 */
export async function runConnectSession(opts: ConnectSessionSpawnOptions & { fetchImpl?: FetchLike }): Promise<void> {
	const { cliPath, agentUrl, hubUrl, authToken, connectId, cwd } = opts;
	const fetchImpl = opts.fetchImpl ?? fetch;

	// 1. Register the agent→connectId binding on the hub.
	await bindAgentOnHub(hubUrl, authToken, connectId, connectId, fetchImpl);

	// 2. Spawn executor + TUI in parallel.
	const execChildEnv: Record<string, string | undefined> = {
		...process.env,
		DPI_HUB_URL: hubUrl,
		DPI_CONNECT_ID: connectId,
		DPI_CWD: cwd,
	};
	if (authToken) execChildEnv.DPI_AUTH_TOKEN = authToken;
	const execChild = spawn(process.execPath, buildExecutorChildArgs(cliPath), {
		stdio: ["ignore", "inherit", "inherit"],
		env: execChildEnv as NodeJS.ProcessEnv,
	});
	const tuiChild = spawn(process.execPath, buildConnectChildArgs(cliPath, agentUrl, hubUrl), {
		stdio: "inherit",
		env: { ...process.env, DPI_AUTH_TOKEN: authToken, DPI_CURRENT_AGENT_ID: connectId, DPI_HUB_URL: hubUrl },
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
			// abnormally without cleaning up.
			try {
				if (process.stdin.isTTY) {
					process.stdin.setRawMode(false);
				}
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

	// 3. Unbind so a future /agents/{id}/remote-call from a different session
	// does not hit a stale binding.
	try {
		const headers: Record<string, string> = {};
		if (authToken) headers.Authorization = `Bearer ${authToken}`;
		await fetchImpl(`${hubUrl}/_hub/agents/${connectId}/unbind`, { method: "POST", headers });
	} catch {
		// Unbind is best-effort; the hub will GC stale bindings on executor disconnect.
	}
}

/** Resolve agent ID from spec (UUID prefix or name) */
function resolveAgentId(network: AgentNetworkSnapshot, agentSpec?: string): string {
	if (agentSpec) {
		const match = network.agents.find((a) => a.id === agentSpec || a.id.startsWith(agentSpec));
		if (match) return match.id;
		const byName = network.agents.find((a) => a.name === agentSpec);
		if (byName) return byName.id;
		throw new Error(`Agent not found: ${agentSpec}. Available: ${network.agents.map((a) => a.name).join(", ")}`);
	}
	return network.rootId;
}
