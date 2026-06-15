import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@sheason/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";
import { SourceManager } from "../src/hub/source-manager.ts";
import type { WorkerToHubMessage } from "../src/types.ts";

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

/**
 * Mock IPC worker that simulates the stdio/IPC transport path.
 * Responds to http_query("commands") with the provided command list.
 */
function createMockWorker(commands: Array<{ name: string; description: string; source?: string }>) {
	const listeners = new Set<(message: WorkerToHubMessage) => void>();
	return {
		postMessage(message: unknown) {
			const msg = message as { type: string; requestId: string; query?: string; action?: string };
			if (msg.type === "http_query" || msg.type === "http_request") {
				setTimeout(() => {
					let body: unknown = {};
					if (msg.query === "commands") body = commands;
					if (msg.action === "prompt") body = { ok: true };
					for (const listener of listeners) {
						listener({
							type: "http_response",
							agentName: "root",
							requestId: msg.requestId,
							status: 200,
							body,
						} satisfies WorkerToHubMessage);
					}
				}, 0);
			}
		},
		on(event: string, handler: (message: WorkerToHubMessage) => void) {
			if (event === "message") listeners.add(handler);
		},
		off(event: string, handler: (message: WorkerToHubMessage) => void) {
			if (event === "message") listeners.delete(handler);
		},
	};
}

interface StartedHub {
	url: string;
	gateway: HubGateway;
	sessionToken: string;
}

async function startHub(
	workspaceRoot: string,
	commands: Array<{ name: string; description: string; source?: string }>,
): Promise<StartedHub> {
	const localUser = createLocalUser(workspaceRoot, { name: "cmds-unified", description: "" });
	createAllowedUser(workspaceRoot, {
		name: "allowed-cmds-unified",
		description: "",
		publicKey: localUser.publicKey,
	});
	const mockWorker = createMockWorker(commands);
	const registry = new AgentRegistry(0);
	registry.register({
		name: "root",
		parentName: undefined,
		children: [],
		status: "ready",
		worker: mockWorker as never,
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
	return { url: gateway.url(), gateway, sessionToken: session.token };
}

interface ServeCommand {
	name: string;
	description: string;
	source?: string;
	argumentHint?: string;
}

// Placeholder — this block satisfies the type-only import checker.
// The actual ExtensionAPI / ExtensionCommandContext types are used
// only for type assertions in the original test, not at runtime.
void (null as unknown as ExtensionAPI);
void (null as unknown as ExtensionCommandContext);

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
		const fakeCommands: ServeCommand[] = [
			{ name: "settings", description: "Open settings menu", source: "builtin" },
			{ name: "model", description: "Select model", source: "builtin" },
			{ name: "sources", description: "List all registered sources", source: "extension" },
			{ name: "agents", description: "Switch to a different agent in the network", source: "extension" },
		];
		const hub = await startHub(tempDir!, fakeCommands);
		try {
			const res = await fetch(`${hub.url}/commands`, {
				headers: { Authorization: `Bearer ${hub.sessionToken}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ServeCommand[];
			const names = body.map((c) => c.name);
			expect(names).toContain("sources");
			expect(names).toContain("agents");
			expect(names.filter((n) => n === "agents")).toHaveLength(1);
			expect(names.filter((n) => n === "sources")).toHaveLength(1);
			const agentsEntry = body.find((c) => c.name === "agents");
			expect(agentsEntry?.description).toBe("Switch to a different agent in the network");
			expect(agentsEntry?.source).toBe("extension");
		} finally {
			await hub.gateway.stop();
		}
	});

	it("does not strip the session-management builtins from /commands", async () => {
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
		const hub = await startHub(tempDir!, fakeCommands);
		try {
			const res = await fetch(`${hub.url}/commands`, {
				headers: { Authorization: `Bearer ${hub.sessionToken}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ServeCommand[];
			const names = body.map((c) => c.name);
			expect(names).toEqual(expect.arrayContaining(["resume", "fork", "clone", "new", "tree", "agents", "sources"]));
		} finally {
			await hub.gateway.stop();
		}
	});

	it("regression: if the agent omits /agents, the hub does NOT inject it", async () => {
		const fakeCommands: ServeCommand[] = [
			{ name: "settings", description: "Open settings menu", source: "builtin" },
			{ name: "sources", description: "List all registered sources", source: "extension" },
		];
		const hub = await startHub(tempDir!, fakeCommands);
		try {
			const res = await fetch(`${hub.url}/commands`, {
				headers: { Authorization: `Bearer ${hub.sessionToken}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ServeCommand[];
			expect(body.map((c) => c.name)).not.toContain("agents");
		} finally {
			await hub.gateway.stop();
		}
	});
});
