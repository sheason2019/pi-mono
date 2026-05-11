import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { type AgentRecord, MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { HUB_PROTOCOL_VERSION } from "../../src/hub/transport/protocol.js";
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
		t.execute("tc-isol-1", params as never, undefined, undefined, extCtx) as ReturnType<
			NonNullable<ToolDefinition["execute"]>
		>;
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
			main,
			{ ...child, parentId: child.parentId ?? MAIN_AGENT_ID, lifecycle: child.lifecycle ?? "persistent" },
		],
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
	return new Promise((resolve) => {
		client.emit(
			"peer:hello",
			{ protocolVersion: HUB_PROTOCOL_VERSION, ...payload },
			(ack: { ok: boolean; error?: string }) => resolve(ack),
		);
	});
}

function peerConfig(client: ClientSocket, payload: { tools?: string[] }): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		client.emit("peer:config", payload, (ack: { ok: boolean; error?: string }) => resolve(ack));
	});
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("peer tools and group executor isolation (HubRuntime)", () => {
	it("main and child runtimes use distinct peer registries and peer tool bridges", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "peer-isol-registries-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-iso-1");
		writeFileSync(childPath, `${headerLine("sess-iso-1", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-iso-1",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		await hub.ensureAgentStarted("child-iso-1");
		const mainRt = hub.getRootAgentRuntime();
		const childRt = hub.getAgentRuntime("child-iso-1");
		expect(childRt.peerRegistry).not.toBe(mainRt.peerRegistry);
		expect(childRt.peerToolBridge).not.toBe(mainRt.peerToolBridge);
		await hub.stop();
	});

	it("group tool: parent sees descendant executors while child does not see parent peers", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "peer-isol-list-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-iso-2");
		writeFileSync(childPath, `${headerLine("sess-iso-2", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-iso-2",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${address.port}`;
		const m = await connectClient(base);
		const c = await connectClient(base);
		await peerHello(m, { peerId: "peer-on-main", token: hub.rootTokenForDisplay });
		await peerHello(c, { peerId: "peer-on-child", agentId: "child-iso-2", token: hub.rootTokenForDisplay });

		const mainList = findToolExecute("group", hub.getRootAgentRuntime().tools);
		const childList = findToolExecute("group", hub.getAgentRuntime("child-iso-2").tools);
		expect(mainList).toBeDefined();
		expect(childList).toBeDefined();

		const mainRes = (await mainList!({})) as { content: { type: string; text: string }[] };
		const childRes = (await childList!({})) as { content: { type: string; text: string }[] };
		const mainBody = JSON.parse(mainRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			executors: { peerId: string }[];
		};
		const childBody = JSON.parse(childRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			executors: { peerId: string }[];
		};
		const mainIds = mainBody.executors.map((p) => p.peerId).sort();
		const childIds = childBody.executors.map((p) => p.peerId).sort();
		expect(mainIds).toEqual(["host", "peer-on-child", "peer-on-main"]);
		expect(childIds).toEqual(["host", "peer-on-child"]);
		for (const p of childBody.executors) {
			expect(p.peerId).not.toBe("peer-on-main");
		}

		m.close();
		c.close();
		await hub.stop();
	});

	it("child with disabled hub executor hides host and rejects explicit host peer tool calls", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "peer-isol-host-disabled-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-no-host");
		writeFileSync(childPath, `${headerLine("sess-no-host", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-no-host",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
			hubExecutor: "disabled",
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		await hub.ensureAgentStarted("child-no-host");

		const childGroup = findToolExecute("group", hub.getAgentRuntime("child-no-host").tools);
		expect(childGroup).toBeDefined();
		const groupRes = (await childGroup!({})) as { content: { type: string; text: string }[] };
		const groupBody = JSON.parse(groupRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			executors: { peerId: string }[];
		};
		expect(groupBody.executors.map((executor) => executor.peerId)).not.toContain("host");

		const childRead = findToolExecute("read", hub.getAgentRuntime("child-no-host").tools);
		expect(childRead).toBeDefined();
		await expect(childRead!({ "peer-id": "host", path: "package.json" })).rejects.toThrow(/Hub Executor is disabled/);

		await hub.stop();
	});

	it("peer read tool from child runtime rejects main-bound peer id (not in child registry)", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "peer-isol-x-main-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-iso-3");
		writeFileSync(childPath, `${headerLine("sess-iso-3", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-iso-3",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const m = await connectClient(`http://127.0.0.1:${address.port}`);
		await peerHello(m, { peerId: "exclusive-main", token: hub.rootTokenForDisplay });
		await hub.ensureAgentStarted("child-iso-3");

		const childRead = findToolExecute("read", hub.getAgentRuntime("child-iso-3").tools);
		expect(childRead).toBeDefined();
		await expect(
			childRead!({
				"peer-id": "exclusive-main",
				path: "package.json",
			}),
		).rejects.toThrow(/offline or not registered/);

		m.close();
		await hub.stop();
	});

	it("peer read tool from main runtime can execute a child-bound peer executor", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "peer-isol-x-child-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(workspaceDir, "child-iso-4");
		writeFileSync(childPath, `${headerLine("sess-iso-4", workspaceDir)}\n`, "utf8");
		seedRegistryWithChild(workspaceDir, {
			id: "child-iso-4",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const stub: HubAgentAdapter = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const c = await connectClient(`http://127.0.0.1:${address.port}`);
		await peerHello(c, { peerId: "exclusive-child", agentId: "child-iso-4", token: hub.rootTokenForDisplay });
		await peerConfig(c, { tools: ["read"] });
		c.on("tool:call_request", (payload) => {
			expect(payload.toolName).toBe("read");
			expect(payload.args).toEqual({ path: "package.json" });
			c.emit("tool:call_result", {
				toolCallId: payload.toolCallId,
				result: {
					content: [{ type: "text", text: "read through child executor" }],
					details: undefined,
				},
			});
		});

		const mainRead = findToolExecute("read", hub.getRootAgentRuntime().tools);
		expect(mainRead).toBeDefined();
		const result = (await mainRead!({
			"peer-id": "exclusive-child",
			path: "package.json",
		})) as { content: Array<{ type: string; text?: string }> };
		expect(result.content.find((part) => part.type === "text")?.text).toBe("read through child executor");

		c.close();
		await hub.stop();
	});
});
