import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import type { McpCapabilitySummary, McpRuntimeStatus } from "../../src/hub/mcp/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import {
	HUB_PROTOCOL_VERSION,
	type SessionGetMcpServersAck,
	type SessionGetSkillsAck,
	type SessionMutateMcpServerAck,
} from "../../src/hub/transport/protocol.js";
import {
	createMainOnlySocketHubServer,
	type SocketHubServerMcpMutators,
} from "../../src/hub/transport/socket-hub-server.js";

function createMinimalSnapshot(): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id: "hub-test-session",
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
			version: 3,
		},
		sessionFile: "/tmp/session.json",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning: false,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

function createStubSessionService(): HubSessionService {
	const snapshot = createMinimalSnapshot();
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
	} as unknown as HubSessionService;
}

const emptyCapabilities: McpCapabilitySummary = { tools: [], resources: [], prompts: [] };

function sampleMcpServers(): McpRuntimeStatus[] {
	return [
		{ resourceId: "mcp-a-id", name: "mcp-a", transport: "stdio", status: "running", capabilities: emptyCapabilities },
		{
			resourceId: "mcp-b-id",
			name: "mcp-b",
			transport: "http",
			status: "error",
			error: "connect failed",
			capabilities: emptyCapabilities,
		},
	];
}

function updatedServersAfterPause(): McpRuntimeStatus[] {
	return [
		{ resourceId: "mcp-a-id", name: "mcp-a", transport: "stdio", status: "stopped", capabilities: emptyCapabilities },
	];
}

async function connectClient(port: number): Promise<ClientSocket> {
	const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
		transports: ["websocket"],
		autoConnect: true,
	});
	await new Promise<void>((resolve, reject) => {
		client.on("connect", () => resolve());
		client.on("connect_error", (err) => reject(err));
	});
	return client;
}

async function registerPeer(client: ClientSocket, peerId: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		client.emit(
			"peer:hello",
			{ peerId, token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION },
			(ack: { ok: boolean; error?: string }) => {
				if (ack.ok) {
					resolve();
					return;
				}
				reject(new Error(ack.error ?? "peer:hello failed"));
			},
		);
	});
}

describe("session MCP server socket events", () => {
	it("session:get_skills returns skills from the bound agent resource loader", async () => {
		const mockAdapter = {
			resourceLoader: {
				getSkills: () => ({
					skills: [
						{
							name: "review",
							description: "Review code",
							filePath: "/tmp/skills/review/SKILL.md",
							sourceInfo: { source: "hub" },
							disableModelInvocation: false,
						},
					],
					diagnostics: [{ type: "warning" as const, message: "duplicate ignored", path: "/tmp/other/SKILL.md" }],
				}),
			},
		} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-skills-1");

		const ack = await new Promise<SessionGetSkillsAck>((resolve) => {
			client.emit("session:get_skills", {}, (r: SessionGetSkillsAck) => resolve(r));
		});

		expect(ack.ok).toBe(true);
		if (!ack.ok) {
			throw new Error("expected ok");
		}
		expect(ack.skills).toEqual([
			{
				name: "review",
				description: "Review code",
				filePath: "/tmp/skills/review/SKILL.md",
				sourceInfo: { source: "hub" },
				disableModelInvocation: false,
			},
		]);
		expect(ack.diagnostics).toEqual([{ type: "warning", message: "duplicate ignored", path: "/tmp/other/SKILL.md" }]);

		client.close();
		await server.stop();
	});

	it("session:get_mcp_servers returns servers and omits configError when getConfigError is undefined", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const sample = sampleMcpServers();
		const getMcpServerStatuses = vi.fn((): McpRuntimeStatus[] => sample);
		const getMcpConfigError = vi.fn((): string | undefined => undefined);
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			restartServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			removeServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			getMcpServerStatuses,
			getMcpConfigError,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-1");

		const ack = await new Promise<SessionGetMcpServersAck>((resolve) => {
			client.emit("session:get_mcp_servers", {}, (r: SessionGetMcpServersAck) => resolve(r));
		});

		expect(ack.ok).toBe(true);
		if (!ack.ok) {
			throw new Error("expected ok");
		}
		expect(ack.servers).toEqual(sample);
		expect("configError" in ack).toBe(false);
		expect(getMcpServerStatuses).toHaveBeenCalledTimes(1);
		expect(getMcpConfigError).toHaveBeenCalled();

		client.close();
		await server.stop();
	});

	it("session:get_mcp_servers includes configError when getConfigError returns a string", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const sample = sampleMcpServers();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			restartServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
			removeServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: sample }),
			),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => sample,
			() => "parse error: invalid mcp.json",
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-2");

		const ack = await new Promise<SessionGetMcpServersAck>((resolve) => {
			client.emit("session:get_mcp_servers", {}, (r: SessionGetMcpServersAck) => resolve(r));
		});

		expect(ack.ok).toBe(true);
		if (!ack.ok) {
			throw new Error("expected ok");
		}
		expect(ack.servers).toEqual(sample);
		expect(ack.configError).toBe("parse error: invalid mcp.json");

		client.close();
		await server.stop();
	});

	it("session:pause_mcp_server invokes pauseServer and returns new servers on success", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const after = updatedServersAfterPause();
		const pauseServer = vi.fn(
			async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: after }),
		);
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer,
			restartServer: vi.fn(),
			removeServer: vi.fn(),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-3");

		const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
			client.emit("session:pause_mcp_server", { resourceId: "mcp-a-id" }, (r: SessionMutateMcpServerAck) =>
				resolve(r),
			);
		});

		expect(ack).toEqual({ ok: true, servers: after });
		expect(pauseServer).toHaveBeenCalledWith("root", "mcp-a-id");

		client.close();
		await server.stop();
	});

	it("session:pause_mcp_server returns ok: false when pauseServer returns failure", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({
					ok: false,
					error: 'Unknown MCP server: "nope"',
				}),
			),
			restartServer: vi.fn(),
			removeServer: vi.fn(),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-4");

		const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
			client.emit("session:pause_mcp_server", { resourceId: "nope" }, (r: SessionMutateMcpServerAck) => resolve(r));
		});

		expect(ack).toEqual({ ok: false, error: 'Unknown MCP server: "nope"' });

		client.close();
		await server.stop();
	});

	it("session:restart_mcp_server invokes restartServer and returns new servers on success", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const after = sampleMcpServers();
		const restartServer = vi.fn(
			async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: after }),
		);
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(),
			restartServer,
			removeServer: vi.fn(),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-5");

		const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
			client.emit("session:restart_mcp_server", { resourceId: "mcp-a-id" }, (r: SessionMutateMcpServerAck) =>
				resolve(r),
			);
		});

		expect(ack).toEqual({ ok: true, servers: after });
		expect(restartServer).toHaveBeenCalledWith("root", "mcp-a-id");

		client.close();
		await server.stop();
	});

	it("session:restart_mcp_server returns ok: false when restartServer returns failure", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(),
			restartServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({
					ok: false,
					error: "config write failed",
				}),
			),
			removeServer: vi.fn(),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-6");

		const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
			client.emit("session:restart_mcp_server", { resourceId: "x" }, (r: SessionMutateMcpServerAck) => resolve(r));
		});

		expect(ack).toEqual({ ok: false, error: "config write failed" });

		client.close();
		await server.stop();
	});

	it("session:remove_mcp_server invokes removeServer and returns new servers on success", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const after: McpRuntimeStatus[] = [];
		const removeServer = vi.fn(
			async (_name: string): Promise<SessionMutateMcpServerAck> => ({ ok: true, servers: after }),
		);
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(),
			restartServer: vi.fn(),
			removeServer,
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-7");

		const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
			client.emit("session:remove_mcp_server", { resourceId: "mcp-a-id" }, (r: SessionMutateMcpServerAck) =>
				resolve(r),
			);
		});

		expect(ack).toEqual({ ok: true, servers: after });
		expect(removeServer).toHaveBeenCalledWith("root", "mcp-a-id");

		client.close();
		await server.stop();
	});

	it("session:remove_mcp_server returns ok: false when removeServer returns failure", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(),
			restartServer: vi.fn(),
			removeServer: vi.fn(
				async (_name: string): Promise<SessionMutateMcpServerAck> => ({
					ok: false,
					error: 'Unknown MCP server: "ghost"',
				}),
			),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		await registerPeer(client, "peer-mcp-8");

		const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
			client.emit("session:remove_mcp_server", { resourceId: "ghost" }, (r: SessionMutateMcpServerAck) =>
				resolve(r),
			);
		});

		expect(ack).toEqual({ ok: false, error: 'Unknown MCP server: "ghost"' });

		client.close();
		await server.stop();
	});

	it.each([
		["session:get_mcp_servers", {}],
		["session:pause_mcp_server", { resourceId: "a" }],
		["session:restart_mcp_server", { resourceId: "a" }],
		["session:remove_mcp_server", { resourceId: "a" }],
	] as const)("rejects %s for unregistered peer", async (event, payload) => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(),
			restartServer: vi.fn(),
			removeServer: vi.fn(),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		// no peer:hello

		if (event === "session:get_mcp_servers") {
			const ack = await new Promise<SessionGetMcpServersAck>((resolve) => {
				client.emit(event, payload, (r: SessionGetMcpServersAck) => resolve(r));
			});
			expect(ack.ok).toBe(false);
			if (ack.ok) {
				throw new Error("expected failure");
			}
			expect(ack.error).toMatch(/not registered/i);
		} else {
			const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
				client.emit(event, payload, (r: SessionMutateMcpServerAck) => resolve(r));
			});
			expect(ack.ok).toBe(false);
			if (ack.ok) {
				throw new Error("expected failure");
			}
			expect(ack.error).toMatch(/not registered/i);
		}

		client.close();
		await server.stop();
	});

	it.each(["session:pause_mcp_server", "session:restart_mcp_server", "session:remove_mcp_server"] as const)(
		"returns ok: false for invalid name payload on %s",
		async (event) => {
			const mockAdapter = {} as unknown as HubAgentAdapter;
			const sessionService = createStubSessionService();
			const registry = new PeerRegistry();
			const mcpMutators: SocketHubServerMcpMutators = {
				pauseServer: vi.fn(),
				restartServer: vi.fn(),
				removeServer: vi.fn(),
			};

			const server = createMainOnlySocketHubServer(
				sessionService,
				registry,
				() => [],
				() => mockAdapter,
				() => [],
				undefined,
				() => [],
				() => undefined,
				mcpMutators,
			);

			const address = await server.start({ host: "127.0.0.1", port: 0 });
			const client = await connectClient(address.port);
			await registerPeer(client, "peer-mcp-10");

			const ack = await new Promise<SessionMutateMcpServerAck>((resolve) => {
				client.emit(event, {} as { resourceId: string }, (r: SessionMutateMcpServerAck) => resolve(r));
			});
			expect(ack.ok).toBe(false);
			if (ack.ok) {
				throw new Error("expected failure");
			}
			expect(ack.error).toBeTruthy();
			expect(mcpMutators.pauseServer).not.toHaveBeenCalled();
			expect(mcpMutators.restartServer).not.toHaveBeenCalled();
			expect(mcpMutators.removeServer).not.toHaveBeenCalled();

			client.close();
			await server.stop();
		},
	);
});

describe("peer:hello", () => {
	it("rejects previous protocol version with protocol mismatch", async () => {
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mcpMutators: SocketHubServerMcpMutators = {
			pauseServer: vi.fn(),
			restartServer: vi.fn(),
			removeServer: vi.fn(),
		};

		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
			undefined,
			() => [],
			() => undefined,
			mcpMutators,
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(address.port);
		const oldVersion = HUB_PROTOCOL_VERSION - 1;
		const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			client.emit(
				"peer:hello",
				{ peerId: "stale-proto", token: "test-token", protocolVersion: oldVersion },
				(r: { ok: boolean; error?: string }) => resolve(r),
			);
		});

		expect(ack.ok).toBe(false);
		expect(ack.error).toBe(`Protocol version mismatch: peer=${oldVersion}, hub=${HUB_PROTOCOL_VERSION}`);

		client.close();
		await server.stop();
	});
});
