/**
 * End-to-end multi-agent integration (Task 11): real `HubRuntime` + `SocketHubServer` + socket.io clients.
 *
 * Overlap note: detailed per-feature coverage lives in
 * - `hub-runtime-agents.test.ts` (eager `agentId` source → child adapter, including `initializeAgentAdapter`)
 * - `socket-hub-server-agent-binding.test.ts` (peer bind, scoping, live/event isolation)
 * - `agent-messaging-tools.test.ts` (A2A tools + `enqueueFromAgent` on stubs; `MessageSource` kind `agent` is covered in
 *   `peer-source-metadata.test.ts` via `createAgentMessageSource` + `deliverSourceAwareInbound`)
 *
 * This file adds combined scenarios and the dynamic-child + socket path without re-documenting every assertion.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@sheason/pi-coding-agent";
import { SessionManager } from "@sheason/pi-coding-agent";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { type AgentRecord, MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import type { LiveRenderEvent } from "../../src/hub/transport/live-events.js";
import { HUB_PROTOCOL_VERSION, type SessionCrdtSyncPayload } from "../../src/hub/transport/protocol.js";
import type { SocketHubServer } from "../../src/hub/transport/socket-hub-server.js";
import { getAgentSessionFile, initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

const extCtx = { notify: () => {} } as unknown as ExtensionContext;

function findToolExecute(
	name: string,
	tools: ToolDefinition[],
): ((params: unknown) => ReturnType<NonNullable<ToolDefinition["execute"]>>) | undefined {
	const t = tools.find((x) => x.name === name) as ToolDefinition | undefined;
	if (!t) {
		return undefined;
	}
	return (params: unknown) =>
		t.execute("tc1", params as never, undefined, undefined, extCtx) as ReturnType<
			NonNullable<ToolDefinition["execute"]>
		>;
}

function textResult(value: unknown): string {
	const payload = value as { content?: Array<{ type: string; text?: string }> };
	return payload.content?.find((part) => part.type === "text")?.text ?? "";
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function headerLine(id: string, cwd: string): string {
	return JSON.stringify({
		type: "session" as const,
		version: 3,
		id,
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd,
	});
}

type TestAgentRecord = Omit<AgentRecord, "parentId" | "lifecycle"> &
	Partial<Pick<AgentRecord, "parentId" | "lifecycle">>;

function seedRegistryWithChild(cwd: string, child: TestAgentRecord): void {
	const mainSession = getSessionFile(cwd);
	const main: AgentRecord = {
		id: MAIN_AGENT_ID,
		kind: "root",
		sessionFile: mainSession,
		createdAt: new Date(0).toISOString(),
		lifecycle: "persistent",
	};
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeJson(getAgentsConfigPath(cwd), {
		version: 2 as const,
		agents: [
			{ ...main },
			{ ...child, parentId: child.parentId ?? MAIN_AGENT_ID, lifecycle: child.lifecycle ?? "persistent" },
		],
	});
}

function seedMainOnlyRegistry(cwd: string): void {
	const main: { id: string; kind: "root"; sessionFile: string; createdAt: string; lifecycle: "persistent" } = {
		id: MAIN_AGENT_ID,
		kind: "root",
		sessionFile: getSessionFile(cwd),
		createdAt: new Date(0).toISOString(),
		lifecycle: "persistent",
	};
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeJson(getAgentsConfigPath(cwd), { version: 2 as const, agents: [main] });
}

function seedMainSessionWithDialog(cwd: string): void {
	seedMainOnlyRegistry(cwd);
	const paths = initializeWorkspace(cwd).paths;
	const sm = SessionManager.open(paths.sessionFile, paths.workspaceDir, cwd);
	const ts1 = Date.now();
	sm.appendMessage({ role: "user", content: "main-user-line", timestamp: ts1 });
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "main-assistant-line" }],
		api: "test-messages",
		provider: "test",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ts1 + 1,
	});
}

async function connectClient(addressBase: string): Promise<ClientSocket> {
	const client: ClientSocket = ioClient(addressBase, {
		transports: ["websocket"],
		autoConnect: true,
	});
	await new Promise<void>((resolve, reject) => {
		client.on("connect", () => resolve());
		client.on("connect_error", (err) => reject(err));
	});
	return client;
}

function peerHello(
	client: ClientSocket,
	payload: { peerId: string; agentId?: string; protocolVersion?: number; token?: string },
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve, reject) => {
		client.emit(
			"peer:hello",
			{ token: currentRootToken, protocolVersion: HUB_PROTOCOL_VERSION, ...payload },
			(helloAck: { ok: boolean; error?: string }) => {
				if (!helloAck.ok) {
					resolve(helloAck);
					return;
				}
				client.emit("peer:config", {}, (configAck: { ok: boolean; error?: string }) => {
					if (!configAck.ok) {
						reject(new Error(configAck.error ?? "peer:config failed"));
						return;
					}
					resolve(helloAck);
				});
			},
		);
	});
}

type HubTestInternals = { socketServer: SocketHubServer };
let currentRootToken = "test-token";

function socketServer(hub: HubRuntime): SocketHubServer {
	currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
	return (hub as unknown as HubTestInternals).socketServer;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("multi-agent integration (runtime + socket server)", () => {
	it("main peer and child-a peer: welcome, CRDT sync, peer registries, and queue_write path", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "multi-e2e-main-child-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-a");
		writeFileSync(childPath, `${headerLine("child-sess-mia", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-a",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});

		const mainEnqueue = vi.fn().mockResolvedValue(undefined);
		const childEnqueue = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			n += 1;
			if (n === 1) {
				return {
					subscribeLiveEvents: () => () => {},
					enqueueFromPeer: mainEnqueue,
					dispose: () => {},
				} as unknown as HubAgentAdapter;
			}
			return {
				subscribeLiveEvents: () => () => {},
				enqueueFromPeer: childEnqueue,
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});

		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;

		const cMain = await connectClient(base);
		const cChild = await connectClient(base);
		const wMain = new Promise<{ agentId: string }>((r) => cMain.once("hub:welcome", r));
		const wChild = new Promise<{ agentId: string }>((r) => cChild.once("hub:welcome", r));
		const mainSync: SessionCrdtSyncPayload[] = [];
		const childSync: SessionCrdtSyncPayload[] = [];
		let snapshotCount = 0;
		cMain.on("session:crdt_sync", (payload) => mainSync.push(payload));
		cChild.on("session:crdt_sync", (payload) => childSync.push(payload));
		cMain.on("session:snapshot", () => {
			snapshotCount += 1;
		});
		cChild.on("session:snapshot", () => {
			snapshotCount += 1;
		});

		expect(await peerHello(cMain, { peerId: "e2e-main" })).toEqual({ ok: true });
		expect(await peerHello(cChild, { peerId: "e2e-child", agentId: "child-a" })).toEqual({ ok: true });

		const [wm, wc] = await Promise.all([wMain, wChild]);
		await vi.waitFor(() => {
			expect(mainSync.length).toBeGreaterThan(0);
			expect(childSync.length).toBeGreaterThan(0);
		});
		expect(wm.agentId).toBe(MAIN_AGENT_ID);
		expect(wc.agentId).toBe("child-a");
		expect(snapshotCount).toBe(0);

		const mainPeers = hub
			.getRootAgentRuntime()
			.peerRegistry.list()
			.map((p) => p.peerId)
			.sort();
		const childPeers = hub
			.getAgentRuntime("child-a")
			.peerRegistry.list()
			.map((p) => p.peerId)
			.sort();
		expect(mainPeers).toEqual(["e2e-main"]);
		expect(childPeers).toEqual(["e2e-child"]);

		const pr = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			cChild.emit("session:queue_write", { text: "child-only" }, resolve);
		});
		expect(pr.ok).toBe(true);
		expect(mainEnqueue).not.toHaveBeenCalled();
		expect(childEnqueue).toHaveBeenCalledWith(
			"e2e-child",
			"child-only",
			expect.objectContaining({ authUser: "root" }),
		);

		cMain.close();
		cChild.close();
		await hub.stop();
	});

	it("spawn child after hub.start; new peer hot-connects to spawned id with CRDT sync and queue routing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "multi-e2e-spawn-hot-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainEnqueue = vi.fn().mockResolvedValue(undefined);
		const childEnqueue = vi.fn().mockResolvedValue(undefined);
		let c = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			c += 1;
			const useMain = c === 1;
			return {
				enqueueFromAgent: vi.fn().mockResolvedValue(undefined),
				enqueueFromPeer: useMain ? mainEnqueue : childEnqueue,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(cwd);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;

		const raw = await hub.createChildAgent({ mode: "spawn", background: "bg-spawn" });
		const { childId } = JSON.parse(raw) as { childId: string };
		expect(hub.getAgentRuntime(childId)).toBeDefined();
		expect(hub.getAgentRuntime(childId).agentAdapter).toBeDefined();

		const client = await connectClient(base);
		const w = new Promise<{ agentId: string }>((r) => client.once("hub:welcome", r));
		const syncs: SessionCrdtSyncPayload[] = [];
		let snapshotCount = 0;
		client.on("session:crdt_sync", (payload) => syncs.push(payload));
		client.on("session:snapshot", () => {
			snapshotCount += 1;
		});
		expect(await peerHello(client, { peerId: "hot-peer", agentId: childId })).toEqual({ ok: true });
		const wel = await w;
		await vi.waitFor(() => {
			expect(syncs.length).toBeGreaterThan(0);
		});
		expect(wel.agentId).toBe(childId);
		expect(snapshotCount).toBe(0);

		const pr = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			client.emit("session:queue_write", { text: "p" }, resolve);
		});
		expect(pr.ok).toBe(true);
		expect(mainEnqueue).not.toHaveBeenCalled();
		expect(childEnqueue).toHaveBeenCalledWith("hot-peer", "p", expect.objectContaining({ authUser: "root" }));

		client.close();
		await hub.stop();
	});

	it("A2A tools with server running allow cross-tree agent communication at the adapter boundary", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "multi-e2e-a2a-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainEnqueue = vi.fn().mockResolvedValue(undefined);
		const childEnqueue = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const useMain = n++ === 0;
			return {
				enqueueFromAgent: useMain ? mainEnqueue : childEnqueue,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const hub = HubRuntime.open(cwd);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		await hub.start({ host: "127.0.0.1", port: 0 });

		const spawnEx = findToolExecute("create_child_agent", hub.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((x) => x.type === "text") as { text: string }).text,
		)![1]!;

		const sendMain = findToolExecute("send_message_to_agent", hub.getRootAgentRuntime().tools);
		await sendMain!({ agentIds: childId, message: "m-to-c" });
		expect(mainEnqueue).not.toHaveBeenCalled();
		expect(childEnqueue).toHaveBeenCalledWith("root", "m-to-c");

		childEnqueue.mockClear();
		mainEnqueue.mockClear();
		const bc = findToolExecute("broadcast_message_to_agents", hub.getAgentRuntime(childId).tools);
		const childBroadcast = await bc!({ message: "c-broadcast" });
		expect(childEnqueue).not.toHaveBeenCalled();
		expect(mainEnqueue).toHaveBeenCalledWith(childId, "c-broadcast");
		expect(JSON.parse(textResult(childBroadcast))).toEqual({
			ok: true,
			queued: [MAIN_AGENT_ID],
		});

		await hub.stop();
	});

	it("combined: live updates stay scoped through CRDT only while hub is up", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "multi-e2e-leak-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const chPath = getAgentSessionFile(workspaceDir, "child-leak");
		writeFileSync(chPath, `${headerLine("sess-leak", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-leak",
			kind: "child",
			sessionFile: chPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		currentRootToken = hub.rootTokenForDisplay ?? currentRootToken;
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;
		const m = await connectClient(base);
		const c = await connectClient(base);
		const mSync: SessionCrdtSyncPayload[] = [];
		const cSync: SessionCrdtSyncPayload[] = [];
		let liveEventCount = 0;
		m.on("session:crdt_sync", (payload) => mSync.push(payload));
		c.on("session:crdt_sync", (payload) => cSync.push(payload));
		m.on("session:live", () => {
			liveEventCount += 1;
		});
		c.on("session:live", () => {
			liveEventCount += 1;
		});
		await peerHello(m, { peerId: "leak-m" });
		await peerHello(c, { peerId: "leak-c", agentId: "child-leak" });
		await vi.waitFor(() => {
			expect(mSync.length).toBeGreaterThan(0);
			expect(cSync.length).toBeGreaterThan(0);
		});
		mSync.length = 0;
		cSync.length = 0;
		const ev: LiveRenderEvent = { type: "status", message: "for-main" };
		socketServer(hub).broadcastLiveEvent(MAIN_AGENT_ID, ev);
		await vi.waitFor(() => expect(mSync.length).toBeGreaterThan(0), { timeout: 2000 });
		expect(cSync).toHaveLength(0);
		expect(liveEventCount).toBe(0);
		mSync.length = 0;
		cSync.length = 0;
		socketServer(hub).broadcastLiveEvent("child-leak", { type: "status", message: "for-child" });
		await vi.waitFor(() => expect(cSync.length).toBeGreaterThan(0), { timeout: 2000 });
		expect(mSync).toHaveLength(0);
		expect(liveEventCount).toBe(0);
		m.close();
		c.close();
		await hub.stop();
	});
});
