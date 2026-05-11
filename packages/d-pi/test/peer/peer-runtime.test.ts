import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HUB_PROTOCOL_VERSION, type McpRuntimeStatus, type SourceRuntimeStatus } from "../../src/hub/index.js";
import { PeerRuntime } from "../../src/peer/runtime/peer-runtime.js";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("PeerRuntime hub binding", () => {
	it("includes agentId in hello when set (e.g. child-a)", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", agentId: "child-a" });
		expect(peer.hello.agentId).toBe("child-a");
	});

	it("omits agentId in hello for default (root) binding", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		expect("agentId" in peer.hello).toBe(false);
	});

	it("keeps executor enabled by default for existing peer behavior", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		expect(peer.hello.executorEnabled).toBeUndefined();
		expect("tools" in peer.hello).toBe(false);
		expect("configSnapshot" in peer.hello).toBe(false);
	});

	it("can connect with executor disabled and without declaring tools", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", executorEnabled: false });
		expect(peer.hello.executorEnabled).toBe(false);
		expect("tools" in peer.hello).toBe(false);
	});

	it("getBoundAgentId is root when no welcome and no hello agent", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		expect(peer.getBoundAgentId()).toBe("root");
	});

	it("getBoundAgentId uses peer hello while welcome is not yet received", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", agentId: "child-a" });
		expect(peer.getBoundAgentId()).toBe("child-a");
	});

	it("getBoundAgentId prefers hub welcome over hello", () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", agentId: "child-a" });
		peer.appState.applyWelcome({
			sessionId: "s",
			peerId: "p",
			agentId: "child-b",
			hubVersion: "0",
			protocolVersion: HUB_PROTOCOL_VERSION,
			toolNames: [],
			identity: {
				id: "root",
				name: "root",
				description: "root",
				user: "test-user",
				purpose: "test access",
				scopeRootAgentId: "root",
				createdByAgentId: "root",
				root: true,
			},
			scopeRootAgentId: "root",
		});
		expect(peer.getBoundAgentId()).toBe("child-b");
	});

	it("switchAgent reconnects with the same peer config and new agent id", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", peerId: "peer-a" });
		const internals = peer as unknown as {
			peerMcpRuntime: {
				getSnapshot: () => { servers: [] };
				getRemoteToolNames: (peerId: string) => string[];
			};
			peerSourceRuntime: {
				stop: () => Promise<void>;
				start: () => Promise<void>;
			};
		};
		const calls: string[] = [];
		vi.spyOn(internals.peerMcpRuntime, "getSnapshot").mockReturnValue({ servers: [] });
		vi.spyOn(internals.peerMcpRuntime, "getRemoteToolNames").mockReturnValue(["peer/tool"]);
		vi.spyOn(internals.peerSourceRuntime, "stop").mockImplementation(async () => {
			calls.push("source-stop");
		});
		vi.spyOn(peer.client, "disconnect").mockImplementation(async () => {
			calls.push("disconnect");
		});
		vi.spyOn(peer.client, "connect").mockImplementation(async () => {
			calls.push(`connect:${peer.hello.agentId}`);
		});
		const uploadConfig = vi.spyOn(peer.client, "uploadConfig").mockImplementation(async () => {
			calls.push("config");
		});
		vi.spyOn(peer.client, "waitForInitialSync").mockImplementation(async () => {
			calls.push("sync");
		});
		vi.spyOn(internals.peerSourceRuntime, "start").mockImplementation(async () => {
			calls.push("source-start");
		});

		await peer.switchAgent("child-a");

		expect(peer.hello.agentId).toBe("child-a");
		expect(calls).toEqual(["source-stop", "disconnect", "connect:child-a", "config", "sync", "source-start"]);
		expect(uploadConfig).toHaveBeenCalledWith(
			expect.objectContaining({ tools: expect.arrayContaining(["peer/tool"]) }),
		);
	});

	it("starts sources only after peer config is prepared and the hub connection is synchronized", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		const internals = peer as unknown as {
			peerMcpRuntime: {
				start: () => Promise<void>;
				getSnapshot: () => { servers: [] };
				getRemoteToolNames: (peerId: string) => string[];
			};
			peerSourceRuntime: { start: () => Promise<void> };
		};
		const calls: string[] = [];
		vi.spyOn(internals.peerMcpRuntime, "start").mockImplementation(async () => {
			calls.push("mcp");
		});
		vi.spyOn(internals.peerMcpRuntime, "getSnapshot").mockReturnValue({ servers: [] });
		vi.spyOn(internals.peerMcpRuntime, "getRemoteToolNames").mockReturnValue([]);
		vi.spyOn(peer.client, "connect").mockImplementation(async () => {
			calls.push("connect");
		});
		vi.spyOn(peer.client, "uploadConfig").mockImplementation(async () => {
			calls.push("config");
		});
		vi.spyOn(peer.client, "waitForInitialSync").mockImplementation(async () => {
			calls.push("sync");
		});
		vi.spyOn(internals.peerSourceRuntime, "start").mockImplementation(async () => {
			calls.push("source");
		});

		await peer.start();

		expect(calls).toEqual(["mcp", "connect", "config", "sync", "source"]);
		expect(peer.hello).not.toHaveProperty("configHash");
	});

	it("uploads a fresh peer config snapshot before hub reload commands", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "peer-runtime-reload-config-"));
		try {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeJson(join(cwd, ".pi", "models.json"), {
				providers: { local: { models: [{ id: "before-reload", api: "openai-responses" }] } },
			});
			const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", cwd });
			writeJson(join(cwd, ".pi", "models.json"), {
				providers: { local: { models: [{ id: "after-reload", api: "openai-responses" }] } },
			});
			const uploadConfig = vi.spyOn(peer.client, "uploadConfig").mockResolvedValue(undefined);
			const invokeCommand = vi.spyOn(peer.client, "invokeCommand").mockResolvedValue(undefined);

			await peer.invokeCommand("reload");

			expect(uploadConfig.mock.invocationCallOrder[0]).toBeLessThan(invokeCommand.mock.invocationCallOrder[0] ?? 0);
			expect(uploadConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					configSnapshot: expect.objectContaining({
						cwdLayer: expect.objectContaining({
							models: expect.objectContaining({
								providers: expect.objectContaining({
									local: expect.objectContaining({
										models: expect.arrayContaining([expect.objectContaining({ id: "after-reload" })]),
									}),
								}),
							}),
						}),
					}),
				}),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not start peer MCP executor tools when executor is disabled", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", executorEnabled: false });
		const internals = peer as unknown as {
			peerMcpRuntime: {
				start: () => Promise<void>;
				getSnapshot: () => { servers: [] };
				getRemoteToolNames: (peerId: string) => string[];
			};
			peerSourceRuntime: { start: () => Promise<void> };
		};
		const mcpStart = vi.spyOn(internals.peerMcpRuntime, "start").mockImplementation(async () => {});
		const getRemoteToolNames = vi
			.spyOn(internals.peerMcpRuntime, "getRemoteToolNames")
			.mockReturnValue(["peer/tool"]);
		vi.spyOn(peer.client, "connect").mockImplementation(async () => {});
		const uploadConfig = vi.spyOn(peer.client, "uploadConfig").mockImplementation(async () => {});
		vi.spyOn(peer.client, "waitForInitialSync").mockImplementation(async () => {});
		vi.spyOn(internals.peerSourceRuntime, "start").mockImplementation(async () => {});

		await peer.start();

		expect(mcpStart).not.toHaveBeenCalled();
		expect(getRemoteToolNames).not.toHaveBeenCalled();
		expect(uploadConfig).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
		expect("mcpSnapshot" in peer.hello).toBe(false);
		expect("tools" in peer.hello).toBe(false);
	});
});

const emptyStatus: McpRuntimeStatus = {
	name: "x",
	transport: "stdio",
	status: "running",
	capabilities: { tools: [], resources: [], prompts: [] },
};

const hubSourceStatus: SourceRuntimeStatus = {
	resourceId: "shared-source",
	name: "shared",
	transport: "stdio",
	agentId: "root",
	origin: "hub",
	status: "running",
};

const peerSourceStatus: SourceRuntimeStatus = {
	resourceId: "shared-source",
	name: "shared",
	transport: "stdio",
	agentId: "root",
	origin: "peer",
	peerId: "peer-a",
	status: "running",
};

describe("PeerRuntime source delegations", () => {
	it("pauseSource pauses matching hub and peer-local sources", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", peerId: "peer-a" });
		const internals = peer as unknown as {
			peerSourceRuntime: {
				getMatchingLocalSourceResourceIds: (resourceId: string) => string[];
				pauseSource: (resourceId: string) => Promise<void>;
				getStatuses: () => SourceRuntimeStatus[];
			};
		};
		const calls: string[] = [];
		vi.spyOn(peer.client, "pauseSource").mockImplementation(async () => {
			calls.push("hub");
			return [hubSourceStatus];
		});
		vi.spyOn(peer.client, "getSessionSources").mockResolvedValue([hubSourceStatus]);
		vi.spyOn(internals.peerSourceRuntime, "getMatchingLocalSourceResourceIds").mockImplementation((resourceId) =>
			resourceId === "peer-only" ? ["peer-only"] : ["shared-source"],
		);
		vi.spyOn(internals.peerSourceRuntime, "pauseSource").mockImplementation(async () => {
			calls.push("peer");
		});
		vi.spyOn(internals.peerSourceRuntime, "getStatuses").mockReturnValue([peerSourceStatus]);

		const result = await peer.pauseSource("shared-source");

		expect(calls).toEqual(["hub", "peer"]);
		expect(result).toEqual([hubSourceStatus, peerSourceStatus]);
	});

	it("restartSource prefers hub and falls back to peer-local sources only when hub does not know the id", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t", peerId: "peer-a" });
		const internals = peer as unknown as {
			peerSourceRuntime: {
				getMatchingLocalSourceResourceIds: (resourceId: string) => string[];
				restartSource: (resourceId: string) => Promise<void>;
				getStatuses: () => SourceRuntimeStatus[];
			};
		};
		vi.spyOn(internals.peerSourceRuntime, "getMatchingLocalSourceResourceIds").mockImplementation((resourceId) =>
			resourceId === "peer-only" ? ["peer-only"] : ["shared-source"],
		);
		const restartLocal = vi.spyOn(internals.peerSourceRuntime, "restartSource").mockResolvedValue(undefined);
		vi.spyOn(internals.peerSourceRuntime, "getStatuses").mockReturnValue([peerSourceStatus]);
		const getHubSources = vi.spyOn(peer.client, "getSessionSources").mockResolvedValue([hubSourceStatus]);
		const restartHub = vi.spyOn(peer.client, "restartSource").mockResolvedValue([hubSourceStatus]);

		const hubResult = await peer.restartSource("shared-source");

		expect(restartHub).toHaveBeenCalledWith("shared-source");
		expect(restartLocal).not.toHaveBeenCalled();
		expect(hubResult).toEqual([hubSourceStatus, peerSourceStatus]);

		restartHub.mockRejectedValueOnce(new Error('Source resourceId "peer-only" not found'));
		getHubSources.mockResolvedValueOnce([]);
		const peerResult = await peer.restartSource("peer-only");

		expect(restartLocal).toHaveBeenCalledWith("peer-only");
		expect(peerResult).toEqual([peerSourceStatus]);
	});
});

describe("PeerRuntime MCP server delegations", () => {
	it("getMcpServers passes through to the client", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		const resolved = { servers: [emptyStatus] as McpRuntimeStatus[] };
		const spy = vi.spyOn(peer.client, "getMcpServers").mockResolvedValue(resolved);
		try {
			const result = await peer.getMcpServers();
			expect(spy).toHaveBeenCalledTimes(1);
			expect(result).toBe(resolved);
		} finally {
			spy.mockRestore();
		}
	});

	it("getMcpServers pass-through when configError is set", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		const resolved = { servers: [] as McpRuntimeStatus[], configError: "parse error" };
		const spy = vi.spyOn(peer.client, "getMcpServers").mockResolvedValue(resolved);
		try {
			const result = await peer.getMcpServers();
			expect(result).toBe(resolved);
		} finally {
			spy.mockRestore();
		}
	});

	it("pauseMcpServer forwards name and return value from the client", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		const out = [emptyStatus];
		const spy = vi.spyOn(peer.client, "pauseMcpServer").mockResolvedValue(out);
		try {
			const result = await peer.pauseMcpServer("srv");
			expect(spy).toHaveBeenCalledWith("srv");
			expect(result).toBe(out);
		} finally {
			spy.mockRestore();
		}
	});

	it("restartMcpServer forwards name and return value from the client", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		const out = [emptyStatus];
		const spy = vi.spyOn(peer.client, "restartMcpServer").mockResolvedValue(out);
		try {
			const result = await peer.restartMcpServer("srv");
			expect(spy).toHaveBeenCalledWith("srv");
			expect(result).toBe(out);
		} finally {
			spy.mockRestore();
		}
	});

	it("removeMcpServer forwards name and return value from the client", async () => {
		const peer = new PeerRuntime({ hubUrl: "http://127.0.0.1:1", version: "t" });
		const out = [] as McpRuntimeStatus[];
		const spy = vi.spyOn(peer.client, "removeMcpServer").mockResolvedValue(out);
		try {
			const result = await peer.removeMcpServer("srv");
			expect(spy).toHaveBeenCalledWith("srv");
			expect(result).toBe(out);
		} finally {
			spy.mockRestore();
		}
	});
});
