import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { LocalAgentSessionProxy } from "../../core/local-agent-session-proxy.ts";
import { AgentHttpServer } from "./http-server.ts";

export interface ServeModeOptions {
	port?: number;
}

const DEFAULT_PORT = 8080;

export async function runServeMode(runtime: AgentSessionRuntime, options: ServeModeOptions = {}): Promise<void> {
	const port = options.port ?? DEFAULT_PORT;
	const proxy = new LocalAgentSessionProxy(runtime);
	const server = new AgentHttpServer(proxy);

	// Set up rebindSession callback so the proxy stays in sync
	runtime.setBeforeSessionInvalidate(() => {
		// No UI to reset in serve mode
	});

	runtime.setRebindSession(async (_session) => {
		// Re-subscription happens automatically via the proxy's subscribe()
		// which delegates to the current session. The server's SSE broadcast
		// will pick up events from the new session.
	});

	await server.start(port);

	// Log to stderr so stdout stays clean
	process.stderr.write(`[serve] Listening on port ${port}\n`);
	process.stderr.write(`[serve] Connect with: pi --mode connect --url http://localhost:${port}\n`);

	// Keep process alive
	return new Promise(() => {});
}
