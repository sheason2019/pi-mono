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

/**
 * Run d-pi connect mode using a subprocess model.
 *
 * Spawns `d-pi _connect-child` as a child process with stdio:inherit
 * so the TUI renders directly in the terminal. When the user selects
 * a different agent via /agents, the child writes the target agent ID
 * to AGENT_SWITCH_FILE and exits gracefully (via ctx.shutdown()).
 * The parent detects the switch by checking for the file, then respawns
 * a new child connected to the selected agent.
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

	// 2. Agent switching loop — each iteration spawns a fresh child process
	while (true) {
		const agentUrl = `${url}/agents/${currentAgentId}`;

		await spawnConnectChild(agentUrl, url, currentAgentId, authToken);

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

/** Spawn `d-pi _connect-child` as a child process and wait for it to exit. */
export function buildConnectChildArgs(cliPath: string, agentUrl: string, hubUrl: string): string[] {
	if (cliPath.endsWith(".ts")) {
		return ["--import", "tsx", cliPath, "_connect-child", agentUrl, hubUrl];
	}
	return [cliPath, "_connect-child", agentUrl, hubUrl];
}

function spawnConnectChild(
	agentUrl: string,
	hubUrl: string,
	currentAgentId: string,
	authToken: string | undefined,
): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, buildConnectChildArgs(process.argv[1]!, agentUrl, hubUrl), {
			stdio: "inherit",
			env: { ...process.env, DPI_AUTH_TOKEN: authToken, DPI_CURRENT_AGENT_ID: currentAgentId, DPI_HUB_URL: hubUrl },
		});

		child.on("exit", () => {
			// Safety net: restore terminal state in case the child exited
			// abnormally without cleaning up (e.g. SIGKILL, unhandled error
			// during shutdown). This is a no-op if the child restored properly.
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
		});

		child.on("error", (err) => {
			process.stderr.write(`[d-pi connect] Failed to spawn child: ${err.message}\n`);
			resolve();
		});
	});
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
