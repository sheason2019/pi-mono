import type { SessionStateSnapshot } from "../../core/agent-session-proxy.ts";
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

	// TODO: Create InteractiveMode with proxy (requires Task 10 refactoring)
	// For now, just keep the connection alive and print events
	process.stderr.write(`[connect] Connected to ${url}\n`);
	process.stderr.write(`[connect] Model: ${proxy.model}\n`);

	// Keep process alive
	return new Promise(() => {});
}
