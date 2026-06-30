import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowedUser } from "../src/auth/allowed-users.ts";
import { AuthSessionManager } from "../src/auth/auth-session.ts";
import { createLocalUser } from "../src/auth/local-users.ts";
import { signChallenge } from "../src/auth/signing.ts";
import {
	bindAgentOnHub,
	buildExecutorChildArgs,
	type ConnectSessionSpawnOptions,
	type FetchLike,
	runConnectSession,
	runDPiConnectMode,
} from "../src/connect/connect-mode.ts";
import { AgentRegistry } from "../src/hub/agent-registry.ts";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";
import { HubGateway } from "../src/hub/gateway.ts";

const childProcessMocks = vi.hoisted(() => {
	interface SpawnOptionsForTest {
		stdio?: unknown;
		env?: NodeJS.ProcessEnv;
	}
	interface SpawnCall {
		command: string;
		args: readonly string[];
		options: SpawnOptionsForTest;
	}
	interface FakeChild {
		killed: boolean;
		kill(signal?: string): boolean;
		on(event: string, listener: () => void): FakeChild;
		emitExit(): void;
	}
	const spawnCalls: SpawnCall[] = [];
	const children: FakeChild[] = [];
	const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptionsForTest) => {
		const listeners = new Map<string, Array<() => void>>();
		const child: FakeChild = {
			killed: false,
			kill: () => {
				child.killed = true;
				return true;
			},
			on: (event, listener) => {
				const existing = listeners.get(event) ?? [];
				existing.push(listener);
				listeners.set(event, existing);
				return child;
			},
			emitExit: () => {
				for (const listener of listeners.get("exit") ?? []) {
					listener();
				}
			},
		};
		spawnCalls.push({ command, args: [...args], options });
		children.push(child);
		return child;
	});
	return {
		spawn,
		spawnCalls,
		children,
		reset: () => {
			spawn.mockClear();
			spawnCalls.length = 0;
			children.length = 0;
		},
	};
});

vi.mock("node:child_process", () => ({
	spawn: childProcessMocks.spawn,
}));

let tempDir: string | undefined;
function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

afterEach(() => {
	childProcessMocks.reset();
});

const DPI_ENV_KEYS = ["DPI_AUTH_TOKEN", "DPI_CONNECT_ID", "DPI_CURRENT_AGENT_NAME", "DPI_HUB_URL", "DPI_CWD"] as const;

type DPiEnvKey = (typeof DPI_ENV_KEYS)[number];

function setDpiEnvForTest(values: Record<DPiEnvKey, string>): () => void {
	const previous = new Map<DPiEnvKey, string | undefined>();
	for (const key of DPI_ENV_KEYS) {
		previous.set(key, process.env[key]);
		process.env[key] = values[key];
	}
	return () => {
		for (const key of DPI_ENV_KEYS) {
			const value = previous.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

describe("buildExecutorChildArgs", () => {
	it("uses tsx when cliPath is a .ts file", () => {
		expect(buildExecutorChildArgs("/abs/path/d-pi.ts")).toEqual([
			"--import",
			"tsx",
			"/abs/path/d-pi.ts",
			"_executor-child",
		]);
	});

	it("invokes the binary directly when cliPath is a built script", () => {
		expect(buildExecutorChildArgs("/usr/local/bin/d-pi")).toEqual(["/usr/local/bin/d-pi", "_executor-child"]);
	});
});

describe("bindAgentOnHub", () => {
	let bindUrl: string;
	let bindToken: string;
	let bindGateway: HubGateway;
	beforeEach(async () => {
		createTempDir("d-pi-bind-");
		const localUser = createLocalUser(tempDir!, { name: "u", description: "" });
		createAllowedUser(tempDir!, { name: "u", description: "", publicKey: localUser.publicKey });
		const execReg = new ExecutorRegistry();
		const gateway = new HubGateway(
			new AgentRegistry(),
			async () => ({ agentName: "a" }),
			async () => {},
			new AuthSessionManager(tempDir!),
			execReg,
		);
		await gateway.start(0);
		bindUrl = gateway.url();
		bindGateway = gateway;
		const ch = (await (
			await fetch(`${bindUrl}/api/auth/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicKey: localUser.publicKey }),
			})
		).json()) as { challengeId: string; challenge: string };
		const session = (await (
			await fetch(`${bindUrl}/api/auth/session`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					publicKey: localUser.publicKey,
					challengeId: ch.challengeId,
					signature: signChallenge(localUser, ch.challenge),
				}),
			})
		).json()) as { token: string };
		bindToken = session.token;
	});
	afterEach(async () => {
		await bindGateway.stop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("POSTs to /api/agents/{id}/bind with the connect id and bearer auth", async () => {
		await bindAgentOnHub(bindUrl, bindToken, "agent-1", "connect-1");

		const res = await fetch(`${bindUrl}/agents/agent-1/remote-call`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bindToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ callId: "c-1", tool: "bash", params: {} }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/Executor not available/i);
	});

	it("omits the Authorization header when no token is provided (dev mode)", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(u), init });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		await bindAgentOnHub("http://hub", undefined, "agent-2", "connect-2", fetchImpl);
		expect(calls).toHaveLength(1);
		const init = calls[0]!.init!;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("encodes the agent name path segment and sends the connect id", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined; body: unknown }> = [];
		const fetchImpl = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			calls.push({ url: String(u), init, body });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		await bindAgentOnHub("http://hub", "token", "root agent", "connect-1", fetchImpl);

		expect(calls).toEqual([
			expect.objectContaining({
				url: "http://hub/api/agents/root%20agent/bind",
				body: { connectId: "connect-1" },
			}),
		]);
	});

	it("throws when the hub returns non-2xx", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
		await expect(bindAgentOnHub("http://hub", "tok", "a", "c", fetchImpl)).rejects.toThrow(/500/);
	});
});

describe("runConnectSession", () => {
	it("binds and unbinds by agent name while keeping executor connect id separate from TUI agent name", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined; body: unknown }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			calls.push({ url: String(url), init, body });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const session = runConnectSession({
			cliPath: "/usr/local/bin/d-pi",
			agentUrl: "http://hub/agents/root%20agent",
			hubUrl: "http://hub",
			authToken: "session-token",
			agentName: "root agent",
			connectId: "connect-uuid",
			cwd: "/tmp/d-pi-workspace",
			fetchImpl,
		});
		await vi.waitFor(() => {
			expect(childProcessMocks.children).toHaveLength(2);
		});
		childProcessMocks.children[1]!.emitExit();
		await session;

		expect(
			calls.map((call) => ({
				url: call.url,
				method: call.init?.method,
				body: call.body,
			})),
		).toEqual([
			{
				url: "http://hub/api/agents/root%20agent/bind",
				method: "POST",
				body: { connectId: "connect-uuid" },
			},
			{
				url: "http://hub/api/agents/root%20agent/unbind",
				method: "POST",
				body: undefined,
			},
		]);
		const executorSpawn = childProcessMocks.spawnCalls[0]!;
		const tuiSpawn = childProcessMocks.spawnCalls[1]!;
		expect(executorSpawn.args).toEqual(["/usr/local/bin/d-pi", "_executor-child"]);
		expect(executorSpawn.options.stdio).toEqual(["ignore", "ignore", "ignore"]);
		expect(executorSpawn.options.env?.DPI_CONNECT_ID).toBe("connect-uuid");
		expect(executorSpawn.options.env?.DPI_AUTH_TOKEN).toBe("session-token");
		expect(tuiSpawn.args).toEqual([
			"/usr/local/bin/d-pi",
			"_connect-child",
			"http://hub/agents/root%20agent",
			"http://hub",
		]);
		expect(tuiSpawn.options.env?.DPI_CURRENT_AGENT_NAME).toBe("root agent");
		expect(tuiSpawn.options.env?.DPI_CONNECT_ID).toBeUndefined();
		expect(tuiSpawn.options.env?.DPI_AUTH_TOKEN).toBe("session-token");
		expect(tuiSpawn.options.env?.DPI_HUB_URL).toBe("http://hub");
	});

	it("does not leak stale d-pi environment into executor or TUI children", async () => {
		const restoreEnv = setDpiEnvForTest({
			DPI_AUTH_TOKEN: "stale-token",
			DPI_CONNECT_ID: "stale-connect",
			DPI_CURRENT_AGENT_NAME: "stale-agent",
			DPI_HUB_URL: "http://stale-hub",
			DPI_CWD: "/stale/cwd",
		});
		try {
			const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

			const session = runConnectSession({
				cliPath: "/usr/local/bin/d-pi",
				agentUrl: "http://hub/agents/root%20agent",
				hubUrl: "http://hub",
				authToken: undefined,
				agentName: "root agent",
				connectId: "connect-uuid",
				cwd: "/tmp/d-pi-workspace",
				fetchImpl,
			});
			await vi.waitFor(() => {
				expect(childProcessMocks.children).toHaveLength(2);
			});
			childProcessMocks.children[1]!.emitExit();
			await session;

			const executorEnv = childProcessMocks.spawnCalls[0]!.options.env;
			const tuiEnv = childProcessMocks.spawnCalls[1]!.options.env;
			expect(executorEnv?.DPI_AUTH_TOKEN).toBeUndefined();
			expect(executorEnv?.DPI_CONNECT_ID).toBe("connect-uuid");
			expect(executorEnv?.DPI_CURRENT_AGENT_NAME).toBeUndefined();
			expect(executorEnv?.DPI_HUB_URL).toBe("http://hub");
			expect(executorEnv?.DPI_CWD).toBe("/tmp/d-pi-workspace");
			expect(tuiEnv?.DPI_AUTH_TOKEN).toBeUndefined();
			expect(tuiEnv?.DPI_CONNECT_ID).toBeUndefined();
			expect(tuiEnv?.DPI_CURRENT_AGENT_NAME).toBe("root agent");
			expect(tuiEnv?.DPI_HUB_URL).toBe("http://hub");
			expect(tuiEnv?.DPI_CWD).toBeUndefined();
		} finally {
			restoreEnv();
		}
	});
});

describe("runDPiConnectMode", () => {
	it("passes the resolved agent name and a UUID connect id to the connect session", async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (path === "/api/team") {
				return new Response(
					JSON.stringify({
						rootName: "root agent",
						agents: [{ name: "root agent", status: "ready" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		let capturedOpts: (ConnectSessionSpawnOptions & { fetchImpl?: FetchLike }) | undefined;
		const runSession = vi.fn(async (opts: NonNullable<typeof capturedOpts>) => {
			capturedOpts = opts;
		});

		await runDPiConnectMode(
			{
				url: "http://hub",
				cliPath: "/usr/local/bin/d-pi",
			},
			{
				fetchImpl,
				runSession,
				createConnectId: () => "123e4567-e89b-12d3-a456-426614174000",
			},
		);

		expect(runSession).toHaveBeenCalledOnce();
		expect(capturedOpts?.agentName).toBe("root agent");
		expect(capturedOpts?.connectId).toBe("123e4567-e89b-12d3-a456-426614174000");
	});
});
