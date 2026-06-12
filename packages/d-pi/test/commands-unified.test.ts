import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@sheason/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { createDPiExtension } from "../src/extension/index.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import type { AgentRecord } from "../src/types.ts";

// ── Worker-factory tests ─────────────────────────────────────────────

interface RegisteredCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function captureWorkerCommands(): RegisteredCommand[] {
	const commands = new Map<string, RegisteredCommand>();
	const { factory } = createDPiExtension({
		mode: "worker",
		agentName: "agent-1",
		postToHub: () => {},
	});
	const api = {
		on: () => {},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) => {
			commands.set(name, { name, ...options });
		},
	} as unknown as ExtensionAPI;
	factory(api);
	return Array.from(commands.values());
}

describe("d-pi worker factory registers /agents and /sources", () => {
	it("registers /sources as a no-op stub", () => {
		const commands = captureWorkerCommands();
		const sources = commands.find((c) => c.name === "sources");
		expect(sources, "worker factory must register /sources").toBeDefined();
		expect(sources?.description).toBe("List all registered sources");
	});

	it("registers /agents as a no-op stub", () => {
		const commands = captureWorkerCommands();
		const agents = commands.find((c) => c.name === "agents");
		expect(agents, "worker factory must register /agents").toBeDefined();
		expect(agents?.description).toBe("Switch to a different agent in the group architecture");
	});

	it("does not call fetch or any network from the worker-side handler", async () => {
		const commands = captureWorkerCommands();
		// Both no-op handlers must resolve cleanly without touching the network.
		// We deliberately pass an undefined context — any well-behaved no-op
		// should not dereference it.
		await expect(
			commands.find((c) => c.name === "sources")!.handler("", undefined as never),
		).resolves.toBeUndefined();
		await expect(commands.find((c) => c.name === "agents")!.handler("", undefined as never)).resolves.toBeUndefined();
	});
});

// ── Client-factory sanity check (unchanged) ──────────────────────────

function captureClientCommands(): RegisteredCommand[] {
	const commands = new Map<string, RegisteredCommand>();
	const { factory } = createDPiExtension({
		mode: "client",
		hubUrl: "http://localhost:9090",
	});
	const api = {
		on: () => {},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) => {
			commands.set(name, { name, ...options });
		},
	} as unknown as ExtensionAPI;
	factory(api);
	return Array.from(commands.values());
}

describe("d-pi client factory still owns the real /agents and /sources handlers", () => {
	it("client factory registers both /agents and /sources", () => {
		const commands = captureClientCommands();
		expect(
			commands.find((c) => c.name === "agents"),
			"client factory must register /agents",
		).toBeDefined();
		expect(
			commands.find((c) => c.name === "sources"),
			"client factory must register /sources",
		).toBeDefined();
	});
});

// ── Hub gateway tests (no more interceptor) ──────────────────────────

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

/** Fake agent server that mimics the agent's `/commands` endpoint. The
 *  shape of the response matches what the real `LocalAgentSessionProxy.getCommands()`
 *  emits: a JSON array of `{ name, description, source }` objects covering
 *  builtins, prompt templates, and extension commands. */
function startFakeAgentServer(commands: Array<{ name: string; description: string; source?: string }>): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/commands") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(commands));
			return;
		}
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
	return new Promise((resolve, reject) => {
		server.listen(0, () => {
			const address = server.address() as AddressInfo;
			resolve({
				port: address.port,
				close: () =>
					new Promise<void>((closeResolve, closeReject) =>
						server.close((err) => (err ? closeReject(err) : closeResolve())),
					),
			});
		});
		server.on("error", reject);
	});
}

interface StartedHub {
	url: string;
	gateway: HubGateway;
	sessionToken: string;
	port: number;
}

async function startHub(workspaceRoot: string, agentPort: number): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "cmds-unified", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-cmds-unified",
		description: "",
		publicKey: localUser.publicKey,
	});
	const registry = new AgentRegistry(0);
	registry.register({
		// "root" is the default proxy target for hub-rooted /commands
		// calls (the gateway's catch-all / proxy looks up `getRootAgent()`).
		// Earlier versions of this test used "agent-1" as a stand-in,
		// but with the name-as-identity refactor the root name IS the
		// proxy key — it must literally be "root" for the default route
		// to land here.
		name: "root",
		parentName: undefined,
		children: [],
		port: agentPort,
		status: "ready",
		worker: {} as AgentRecord["worker"],
		cwd: workspaceRoot,
		model: undefined,
	});
	const gateway = new HubGateway(
		registry,
		new SourceManager(() => {}),
		async () => ({ agentName: "created" }),
		async () => {},
		new AuthSessionManager(workspaceRoot),
	);
	await gateway.start(0);
	const ch = (await (
		await fetch(`${gateway.url()}/_hub/auth/challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publicKey: localUser.publicKey }),
		})
	).json()) as { challengeId: string; challenge: string };
	const session = (await (
		await fetch(`${gateway.url()}/_hub/auth/session`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				publicKey: localUser.publicKey,
				challengeId: ch.challengeId,
				signature: signChallenge(localUser, ch.challenge),
			}),
		})
	).json()) as { token: string };
	return { url: gateway.url(), gateway, sessionToken: session.token, port: agentPort };
}

interface ServeCommand {
	name: string;
	description: string;
	source?: string;
	argumentHint?: string;
}

describe("d-pi hub gateway no longer rewrites /commands", () => {
	beforeEach(() => {
		createTempDir("d-pi-cmds-unified-");
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("GET /commands on the hub proxies the agent's /commands response verbatim", async () => {
		// Build a fake agent response that includes BOTH /agents and /sources
		// in the natural position — exactly what a worker with both commands
		// registered in the extension would emit. The hub must forward this
		// list without rewriting, filtering, or re-injecting.
		const fakeCommands: ServeCommand[] = [
			{ name: "settings", description: "Open settings menu", source: "builtin" },
			{ name: "model", description: "Select model", source: "builtin" },
			{ name: "sources", description: "List all registered sources", source: "extension" },
			{ name: "agents", description: "Switch to a different agent in the network", source: "extension" },
		];
		const agent = await startFakeAgentServer(fakeCommands);
		const hub = await startHub(tempDir!, agent.port);
		try {
			const res = await fetch(`${hub.url}/commands`, {
				headers: { Authorization: `Bearer ${hub.sessionToken}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ServeCommand[];
			const names = body.map((c) => c.name);
			expect(names).toContain("sources");
			expect(names).toContain("agents");
			// Sanity: the hub must not duplicate the entry the agent already sent.
			expect(names.filter((n) => n === "agents")).toHaveLength(1);
			expect(names.filter((n) => n === "sources")).toHaveLength(1);
			// The /agents entry should match the worker-factory description
			// (not the old "Switch to a different agent (d-pi)" / "dpi-hub"
			// source that the interceptor used to inject).
			const agentsEntry = body.find((c) => c.name === "agents");
			expect(agentsEntry?.description).toBe("Switch to a different agent in the network");
			expect(agentsEntry?.source).toBe("extension");
		} finally {
			await hub.gateway.stop();
			await agent.close();
		}
	});

	it("does not strip the session-management builtins from /commands", async () => {
		// The old interceptor blocked resume/fork/clone/new/tree from the
		// agent's response. After the fix, all builtins flow through.
		const fakeCommands: ServeCommand[] = [
			{ name: "settings", description: "Open settings menu", source: "builtin" },
			{ name: "resume", description: "Resume a different session", source: "builtin" },
			{ name: "fork", description: "Create a new fork from a previous user message", source: "builtin" },
			{ name: "clone", description: "Duplicate the current session at the current position", source: "builtin" },
			{ name: "new", description: "Start a new session", source: "builtin" },
			{ name: "tree", description: "Navigate session tree (switch branches)", source: "builtin" },
			{ name: "agents", description: "Switch to a different agent in the network", source: "extension" },
			{ name: "sources", description: "List all registered sources", source: "extension" },
		];
		const agent = await startFakeAgentServer(fakeCommands);
		const hub = await startHub(tempDir!, agent.port);
		try {
			const res = await fetch(`${hub.url}/commands`, {
				headers: { Authorization: `Bearer ${hub.sessionToken}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ServeCommand[];
			const names = body.map((c) => c.name);
			// All builtins and both d-pi commands must be present, unfiltered.
			expect(names).toEqual(expect.arrayContaining(["resume", "fork", "clone", "new", "tree", "agents", "sources"]));
		} finally {
			await hub.gateway.stop();
			await agent.close();
		}
	});

	it("regression: if the agent omits /agents, the hub does NOT inject it", async () => {
		// Documents the design decision: the hub is a pure proxy for /commands.
		// Commands are sourced exclusively from the worker factory. If the
		// worker ever drops /agents, autocomplete loses it too — and the fix
		// is to restore the registration, not to bolt on another interceptor.
		const fakeCommands: ServeCommand[] = [
			{ name: "settings", description: "Open settings menu", source: "builtin" },
			{ name: "sources", description: "List all registered sources", source: "extension" },
		];
		const agent = await startFakeAgentServer(fakeCommands);
		const hub = await startHub(tempDir!, agent.port);
		try {
			const res = await fetch(`${hub.url}/commands`, {
				headers: { Authorization: `Bearer ${hub.sessionToken}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ServeCommand[];
			expect(body.map((c) => c.name)).not.toContain("agents");
		} finally {
			await hub.gateway.stop();
			await agent.close();
		}
	});
});
