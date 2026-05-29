import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { SessionStateSnapshot } from "@earendil-works/pi-coding-agent/d-pi-worker";
import { RemoteAgentSessionProxy } from "@earendil-works/pi-coding-agent/d-pi-worker";
import { createDPiClientExtensionFactory } from "../extension/client-extension.ts";
import type { AgentNetworkSnapshot } from "../types.ts";

export interface DPiConnectOptions {
	url: string;
	agent?: string;
}

export async function runDPiConnectMode(options: DPiConnectOptions): Promise<void> {
	const { url, agent: agentSpec } = options;

	// 1. Fetch agent network from Hub
	const networkResponse = await fetch(`${url}/_hub/network`);
	if (!networkResponse.ok) {
		throw new Error(`Failed to fetch agent network: ${networkResponse.status} ${networkResponse.statusText}`);
	}
	const network = (await networkResponse.json()) as AgentNetworkSnapshot;

	// 2. Resolve initial target agent
	let currentAgentId = resolveAgentId(network, agentSpec);

	// 3. Agent switching loop — each iteration creates a fresh InteractiveMode session
	while (true) {
		const agentUrl = `${url}/agents/${currentAgentId}`;

		// Fetch initial state from current agent
		const stateResponse = await fetch(`${agentUrl}/state`);
		if (!stateResponse.ok) {
			throw new Error(`Failed to connect to agent: ${stateResponse.status} ${stateResponse.statusText}`);
		}
		const snapshot = (await stateResponse.json()) as SessionStateSnapshot;

		// Per-session abort controller and switch request holder
		const abortController = new AbortController();
		const switchRequest = { agentId: "" };

		// Create client extension with switch callback
		const clientExtensionFactory = createDPiClientExtensionFactory(url, (newAgentId: string) => {
			switchRequest.agentId = newAgentId;
			abortController.abort();
		});

		// Create InteractiveMode with exitProcess: false so shutdown() doesn't call process.exit()
		const mode = new InteractiveMode(undefined, {
			banner: snapshot.banner,
			clientExtensionFactories: [clientExtensionFactory],
			exitProcess: false,
			abortSignal: abortController.signal,
		});

		// Create proxy — disconnect exits the process only if NOT switching agents
		let switching = false;
		const proxy = new RemoteAgentSessionProxy(agentUrl, snapshot, (reason: string) => {
			mode.showStatus(`Disconnected: ${reason}`);
			if (switching) return; // Agent switch triggered the disconnect — don't exit
			setTimeout(async () => {
				await mode.shutdown();
				process.exit(0);
			}, 1500);
		});
		proxy.hubUrl = url;
		mode.setProxy(proxy);
		await proxy.connect();

		process.stderr.write(`[d-pi connect] Connected to agent ${currentAgentId.slice(0, 8)}...\n`);

		// Run the interactive loop — returns when aborted or shutdown
		await mode.run();

		// Mark as switching before shutdown so proxy disconnect callback doesn't exit the process
		if (switchRequest.agentId) {
			switching = true;
		}

		// Clean up the mode (TUI, proxy, etc.)
		await mode.shutdown();

		// Check if an agent switch was requested
		if (switchRequest.agentId) {
			currentAgentId = switchRequest.agentId;
			continue;
		}

		// No switch requested — normal exit
		break;
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
