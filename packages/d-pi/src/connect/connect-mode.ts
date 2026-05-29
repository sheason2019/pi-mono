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

	// 2. Resolve target agent
	let targetAgentId: string;
	if (agentSpec) {
		// Try as UUID first, then by name
		const match = network.agents.find((a) => a.id === agentSpec || a.id.startsWith(agentSpec));
		if (match) {
			targetAgentId = match.id;
		} else {
			const byName = network.agents.find((a) => a.name === agentSpec);
			if (byName) {
				targetAgentId = byName.id;
			} else {
				throw new Error(
					`Agent not found: ${agentSpec}. Available: ${network.agents.map((a) => a.name).join(", ")}`,
				);
			}
		}
	} else {
		targetAgentId = network.rootId;
	}
	const agentUrl = `${url}/agents/${targetAgentId}`;

	// 3. Fetch initial state from root agent
	const stateResponse = await fetch(`${agentUrl}/state`);
	if (!stateResponse.ok) {
		throw new Error(`Failed to connect to root agent: ${stateResponse.status} ${stateResponse.statusText}`);
	}
	const snapshot = (await stateResponse.json()) as SessionStateSnapshot;

	// 4. Create InteractiveMode with proxy and client-side extension for /agents
	const clientExtensionFactory = createDPiClientExtensionFactory(url);
	const mode = new InteractiveMode(undefined, {
		banner: snapshot.banner,
		clientExtensionFactories: [clientExtensionFactory],
	});
	const proxy = new RemoteAgentSessionProxy(agentUrl, snapshot, (reason: string) => {
		mode.showStatus(`Disconnected: ${reason}`);
		setTimeout(() => void mode.shutdown(), 1500);
	});
	proxy.hubUrl = url;
	mode.setProxy(proxy);
	await proxy.connect();

	process.stderr.write(`[d-pi connect] Connected to agent ${targetAgentId.slice(0, 8)}...\n`);
	process.stderr.write(`[d-pi connect] ${network.agents.length} agent(s) in network\n`);

	await mode.run();
}
