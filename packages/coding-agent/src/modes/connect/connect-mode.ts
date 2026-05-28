import type { SessionStateSnapshot } from "../../core/agent-session-proxy.ts";
import { InteractiveMode } from "../interactive/interactive-mode.ts";
import { RemoteAgentSessionProxy } from "./remote-agent-session-proxy.ts";

export interface ConnectModeOptions {
	url: string;
}

export async function runConnectMode(options: ConnectModeOptions): Promise<void> {
	const { url } = options;

	// Fetch initial state snapshot
	const stateResponse = await fetch(`${url}/state`);
	if (!stateResponse.ok) {
		throw new Error(`Failed to connect to ${url}: ${stateResponse.status} ${stateResponse.statusText}`);
	}
	const snapshot = (await stateResponse.json()) as SessionStateSnapshot;

	// Create remote proxy
	const proxy = new RemoteAgentSessionProxy(url, snapshot);
	await proxy.connect();

	// Run InteractiveMode with the proxy
	const mode = new InteractiveMode(undefined, { proxy });
	await mode.run();
}
