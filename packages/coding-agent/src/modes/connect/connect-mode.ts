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

	// Create InteractiveMode first so we have a reference for graceful shutdown
	const mode = new InteractiveMode(undefined, { banner: snapshot.banner });

	// Create remote proxy with disconnect callback for graceful shutdown
	const proxy = new RemoteAgentSessionProxy(url, snapshot, (reason) => {
		mode.showStatus(`Disconnected: ${reason}`);
		// Schedule shutdown after a brief delay so the user sees the message
		setTimeout(() => void mode.shutdown(), 1500);
	});

	// Assign proxy to mode after construction
	mode.setProxy(proxy);

	await proxy.connect();
	await mode.run();
}
