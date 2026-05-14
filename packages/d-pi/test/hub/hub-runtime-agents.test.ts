import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSessionServices, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { AgentRegistry } from "../../src/hub/agents/agent-registry.js";
import { getChildAgentDir, getChildAgentSessionFile } from "../../src/hub/agents/child-agent-layout.js";
import { type AgentRecord, MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";
import { getAgentSessionFile, initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];

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
	seedRegistryMainAndChildren(cwd, [child]);
}

function seedRegistryMainAndChildren(cwd: string, children: TestAgentRecord[]): void {
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
			...children.map((child) => ({
				...child,
				parentId: child.parentId ?? MAIN_AGENT_ID,
				lifecycle: child.lifecycle ?? "persistent",
			})),
		],
	});
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("HubRuntime multi-agent orchestration", () => {
	it("HubRuntime.open() loads an AgentRegistry (and creates one when missing)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-reg-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		expect(existsSync(getAgentsConfigPath(cwd))).toBe(false);

		const runtime = HubRuntime.open(cwd);
		expect(existsSync(getAgentsConfigPath(cwd))).toBe(true);
		expect(runtime.agentRegistry).toBeInstanceOf(AgentRegistry);
		expect(runtime.getAgentRecords().some((r) => r.id === MAIN_AGENT_ID)).toBe(true);
	});

	it("createAgentTokenText requires explicit user and purpose metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-token-identity-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const runtime = HubRuntime.open(cwd);

		await expect(
			runtime.createAgentTokenText(MAIN_AGENT_ID, {
				name: "guest",
				description: "Guest access",
				user: "",
				purpose: "code review",
			}),
		).rejects.toThrow(/user/i);

		const text = await runtime.createAgentTokenText(MAIN_AGENT_ID, {
			name: "guest",
			description: "Guest access",
			user: "Li Xujie",
			purpose: "code review",
		});
		const parsed = JSON.parse(text) as { user?: string; purpose?: string; token?: string };
		expect(parsed.user).toBe("Li Xujie");
		expect(parsed.purpose).toBe("code review");
		expect(parsed.token).toMatch(/^dpi_/);
	});

	it("createAgentTokenText can create self-scoped tokens for descendants", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-token-self-scope-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		seedRegistryMainAndChildren(cwd, [
			{
				id: "child-a",
				kind: "child",
				sessionFile: getAgentSessionFile(cwd, "child-a"),
				createdAt: new Date(0).toISOString(),
			},
			{
				id: "guest-a",
				kind: "guest",
				parentId: "child-a",
				sessionFile: getAgentSessionFile(cwd, "guest-a"),
				createdAt: new Date(0).toISOString(),
			},
			{
				id: "child-b",
				kind: "child",
				sessionFile: getAgentSessionFile(cwd, "child-b"),
				createdAt: new Date(0).toISOString(),
			},
		]);
		const runtime = HubRuntime.open(cwd);
		const input: Parameters<HubRuntime["createAgentTokenText"]>[1] & {
			scopeMode: "self";
			scopeAgentId: string;
		} = {
			name: "guest a token",
			description: "ACP guest access",
			user: "Guest A",
			purpose: "Connect ACP guest.",
			scopeMode: "self",
			scopeAgentId: "guest-a",
		};

		const text = await runtime.createAgentTokenText("child-a", input);
		const parsed = JSON.parse(text) as { token: string; scope?: { mode: string; rootAgentId: string } };
		const identity = runtime.authTokenStore.authenticate(parsed.token);

		expect(parsed.scope).toEqual({ mode: "self", rootAgentId: "guest-a" });
		expect(identity?.scope).toEqual({ mode: "self", rootAgentId: "guest-a" });
		await expect(runtime.createAgentTokenText("child-a", { ...input, scopeAgentId: "child-b" })).rejects.toThrow(
			/outside caller subtree/i,
		);
	});

	it("revokeAgentTokenText revokes tokens within the caller subtree only", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-token-revoke-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		seedRegistryMainAndChildren(cwd, [
			{
				id: "child-a",
				kind: "child",
				sessionFile: getAgentSessionFile(cwd, "child-a"),
				createdAt: new Date(0).toISOString(),
			},
			{
				id: "child-b",
				kind: "child",
				sessionFile: getAgentSessionFile(cwd, "child-b"),
				createdAt: new Date(0).toISOString(),
			},
		]);
		const runtime = HubRuntime.open(cwd);
		const childAText = await runtime.createAgentTokenText("child-a", {
			name: "child a guest",
			description: "Child A access",
			user: "Guest A",
			purpose: "review child a",
		});
		const childA = JSON.parse(childAText) as { token: string; tokenId: string };
		const childBText = await runtime.createAgentTokenText("child-b", {
			name: "child b guest",
			description: "Child B access",
			user: "Guest B",
			purpose: "review child b",
		});
		const childB = JSON.parse(childBText) as { tokenId: string };

		await expect(runtime.revokeAgentTokenText("child-a", { tokenId: childB.tokenId })).rejects.toThrow(
			/outside caller subtree/i,
		);
		const revokedText = await runtime.revokeAgentTokenText("child-a", { tokenId: childA.tokenId });

		expect(JSON.parse(revokedText)).toEqual(
			expect.objectContaining({ ok: true, tokenId: childA.tokenId, revokedConnections: 0 }),
		);
		expect(runtime.authTokenStore.authenticate(childA.token)).toBeUndefined();
		await expect(runtime.revokeAgentTokenText(MAIN_AGENT_ID, { tokenId: "root" })).rejects.toThrow(/root token/i);
	});

	it("after open, the main agent runtime exists; children hydrate on demand after root init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-main-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(cwd, "helper");
		writeFileSync(childPath, `${headerLine("child-sess", cwd)}\n`, "utf8");
		seedRegistryWithChild(cwd, {
			id: "helper",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});

		const runtime = HubRuntime.open(cwd);
		expect(() => runtime.getAgentRuntime(MAIN_AGENT_ID)).not.toThrow();
		expect(() => runtime.getAgentRuntime("helper")).toThrow();

		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		await runtime.initializeAgentAdapter();

		expect(() => runtime.getAgentRuntime(MAIN_AGENT_ID)).not.toThrow();
		expect(() => runtime.getAgentRuntime("helper")).toThrow();
		const helper = await runtime.ensureAgentStarted("helper");
		expect(helper).toBeDefined();
		expect(helper?.sessionService).not.toBe(runtime.getRootAgentRuntime().sessionService);
	});

	it("defers peer config restarts while the agent is running and coalesces pending changes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-peer-config-defer-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const firstAdapter = {
			subscribeLiveEvents: () => () => {},
			requestInputQueuePump: vi.fn(),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		const secondAdapter = {
			subscribeLiveEvents: () => () => {},
			requestInputQueuePump: vi.fn(),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		const create = vi
			.spyOn(HubAgentAdapter, "create")
			.mockResolvedValueOnce(firstAdapter)
			.mockResolvedValue(secondAdapter);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		runtime.sessionService.setRunState(true);

		const hub = runtime as unknown as {
			setPeerConfigSnapshot(agentId: string, peerId: string, snapshot: unknown): void;
			applyPendingPeerConfigForAgent(agentId: string): Promise<boolean>;
		};
		hub.setPeerConfigSnapshot(MAIN_AGENT_ID, "peer-a", { mcp: { first: true } });
		hub.setPeerConfigSnapshot(MAIN_AGENT_ID, "peer-a", { mcp: { second: true } });
		hub.setPeerConfigSnapshot(MAIN_AGENT_ID, "peer-b", { sources: [{ name: "src-b" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(firstAdapter.abort).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);

		runtime.sessionService.setRunState(false);
		await hub.applyPendingPeerConfigForAgent(MAIN_AGENT_ID);

		expect(create).toHaveBeenCalledTimes(2);
		expect(firstAdapter.abort).toHaveBeenCalledOnce();
		expect(runtime.getRootAgentRuntime().agentAdapter).toBe(secondAdapter);
		expect(
			(runtime as unknown as { configLayers: { listPeerIds(agentId: string): string[] } }).configLayers.listPeerIds(
				MAIN_AGENT_ID,
			),
		).toEqual(["peer-a", "peer-b"]);

		await runtime.stop();
	});

	it("creates child adapters with the child-specific agentDir", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-child-agent-dir-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const childId = "helper";
		const childDir = getChildAgentDir(cwd, childId);
		mkdirSync(childDir, { recursive: true });
		const childPath = getChildAgentSessionFile(cwd, childId);
		writeFileSync(childPath, `${headerLine("child-agent-dir", cwd)}\n`, "utf8");
		seedRegistryWithChild(cwd, {
			id: childId,
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});
		const createArgs: unknown[] = [];
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async (opts) => {
			createArgs.push(opts);
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await runtime.ensureAgentStarted(childId);

		expect(createArgs).toHaveLength(2);
		expect((createArgs[0] as { agentDir?: string }).agentDir).toBeUndefined();
		expect((createArgs[1] as { agentDir?: string }).agentDir).toBe(childDir);
	});

	it("child-bound source that writes JSON-RPC immediately routes to the child adapter (no init race)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-src-child-eager-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(cwd, "src-child");
		writeFileSync(childPath, `${headerLine("child-sess-eager", cwd)}\n`, "utf8");
		seedRegistryWithChild(cwd, {
			id: "src-child",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});

		const rpcLine = JSON.stringify({
			jsonrpc: "2.0",
			method: "queue/write",
			params: { content: "immediate" },
		});
		const nodeArg = `process.stdout.write(${JSON.stringify(rpcLine)}+String.fromCharCode(10))`;
		writeFileSync(
			getSourcesConfigPath(cwd),
			`${JSON.stringify(
				{
					sources: [
						{
							name: "eager-source",
							transport: "stdio",
							command: process.execPath,
							args: ["-e", nodeArg],
							agentId: "src-child",
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const childSubmit = vi.fn().mockResolvedValue(undefined);
		const mainStub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
			enqueueFromSource: vi.fn().mockResolvedValue(undefined),
		} as unknown as HubAgentAdapter;
		const childStub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
			enqueueFromSource: childSubmit,
		} as unknown as HubAgentAdapter;
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			return createN === 1 ? mainStub : childStub;
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		try {
			await runtime.start({ host: "127.0.0.1", port: 0 });

			await vi.waitFor(() => expect(childSubmit).toHaveBeenCalled(), { timeout: 5000 });
			expect(childSubmit).toHaveBeenCalledWith("eager-source", "immediate");
			const srcStatus = runtime.sourceHost.getStatuses().find((s) => s.name === "eager-source");
			expect(srcStatus?.error).toBeUndefined();
			expect(srcStatus?.status).not.toBe("error");
		} finally {
			await runtime.stop();
		}
	});

	it("continues background child hydration and starts sources after one child fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-bg-child-fail-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const badPath = getAgentSessionFile(cwd, "bad-child");
		const srcPath = getAgentSessionFile(cwd, "src-child");
		writeFileSync(badPath, `${headerLine("bad-child-session", cwd)}\n`, "utf8");
		writeFileSync(srcPath, `${headerLine("src-child-session", cwd)}\n`, "utf8");
		seedRegistryMainAndChildren(cwd, [
			{
				id: "bad-child",
				kind: "child",
				sessionFile: badPath,
				createdAt: new Date(0).toISOString(),
			},
			{
				id: "src-child",
				kind: "child",
				sessionFile: srcPath,
				createdAt: new Date(0).toISOString(),
			},
		]);

		const rpcLine = JSON.stringify({
			jsonrpc: "2.0",
			method: "queue/write",
			params: { content: "after-failure" },
		});
		const nodeArg = `process.stdout.write(${JSON.stringify(rpcLine)}+String.fromCharCode(10))`;
		writeFileSync(
			getSourcesConfigPath(cwd),
			`${JSON.stringify(
				{
					sources: [
						{
							name: "source-after-failure",
							transport: "stdio",
							command: process.execPath,
							args: ["-e", nodeArg],
							agentId: "src-child",
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const childSubmit = vi.fn().mockResolvedValue(undefined);
		const mainStub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
			enqueueFromSource: vi.fn().mockResolvedValue(undefined),
		} as unknown as HubAgentAdapter;
		const childStub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
			enqueueFromSource: childSubmit,
		} as unknown as HubAgentAdapter;
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			if (createN === 1) {
				return mainStub;
			}
			if (createN === 2) {
				throw new Error("bad-child-fail");
			}
			return childStub;
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		try {
			await runtime.start({ host: "127.0.0.1", port: 0 });

			await vi.waitFor(() => expect(runtime.getAgentHydrationStatus("bad-child")).toBe("error"));
			await vi.waitFor(() => expect(runtime.getAgentHydrationStatus("src-child")).toBe("running"));
			await vi.waitFor(() => expect(childSubmit).toHaveBeenCalledWith("source-after-failure", "after-failure"), {
				timeout: 5000,
			});
			const srcStatus = runtime.sourceHost.getStatuses().find((s) => s.name === "source-after-failure");
			expect(srcStatus?.error).toBeUndefined();
			expect(srcStatus?.status).not.toBe("error");
		} finally {
			await runtime.stop();
		}
	});

	it("reaches socket listen before slow child hydration finishes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-lazy-child-listen-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(cwd, "slow-child");
		writeFileSync(childPath, `${headerLine("slow-child-session", cwd)}\n`, "utf8");
		seedRegistryWithChild(cwd, {
			id: "slow-child",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});

		let releaseChild!: () => void;
		const childStartBlocked = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			if (createN > 1) {
				await childStartBlocked;
			}
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		expect(createN).toBe(1);
		try {
			const address = await runtime.start({ host: "127.0.0.1", port: 0 });
			expect(address.port).toBeGreaterThan(0);
			await vi.waitFor(() => expect(runtime.getAgentHydrationStatus("slow-child")).toBe("loading"));
			releaseChild();
			await vi.waitFor(() => expect(runtime.getAgentHydrationStatus("slow-child")).toBe("running"));
		} finally {
			releaseChild();
			await runtime.stop();
		}
	});

	it("getAgentRuntime and getRootAgentRuntime return the root agent shell", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-get-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const runtime = HubRuntime.open(cwd);
		const a = runtime.getRootAgentRuntime();
		const b = runtime.getAgentRuntime(MAIN_AGENT_ID);
		const c = runtime.getAgentRuntime();
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("getAgentRuntime fails clearly for an unknown id", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-unknown-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const runtime = HubRuntime.open(cwd);
		expect(() => runtime.getAgentRuntime("no-such")).toThrow(/Unknown agent id: no-such/);
	});

	it("compatibility fields match the main agent runtime", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-alias-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const runtime = HubRuntime.open(cwd);
		const main = runtime.getRootAgentRuntime();
		expect(runtime.sessionService).toBe(main.sessionService);
		expect(runtime.peerRegistry).toBe(main.peerRegistry);
		expect(runtime.tools).toBe(main.tools);
		expect(runtime.peerToolBridge).toBe(main.peerToolBridge);

		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		await runtime.initializeAgentAdapter();
		expect(runtime.agentAdapter).toBe(main.agentAdapter);
	});

	it("stop() disposes all agent runtimes and live forwarding", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-stop-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(cwd, "w2");
		writeFileSync(childPath, `${headerLine("w2", cwd)}\n`, "utf8");
		seedRegistryWithChild(cwd, {
			id: "w2",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});

		const mainDispose = vi.fn();
		const childDispose = vi.fn();
		const mockAdapter = (dispose: () => void): HubAgentAdapter =>
			({
				subscribeLiveEvents: () => () => {},
				dispose,
			}) as unknown as HubAgentAdapter;

		let call = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			call += 1;
			if (call === 1) {
				return mockAdapter(mainDispose);
			}
			return mockAdapter(childDispose);
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await runtime.ensureAgentStarted("w2");
		const rtMain = runtime.getRootAgentRuntime();
		const rtChild = runtime.getAgentRuntime("w2");
		expect(rtMain.agentAdapter).toBeDefined();
		expect(rtChild.agentAdapter).toBeDefined();
		await runtime.stop();
		expect(mainDispose).toHaveBeenCalled();
		expect(childDispose).toHaveBeenCalled();
	});

	it("keeps the root running when a lazy child hydration fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-rollback-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const betaPath = getAgentSessionFile(cwd, "beta");
		writeFileSync(betaPath, `${headerLine("sess-beta", cwd)}\n`, "utf8");
		seedRegistryMainAndChildren(cwd, [
			{
				id: "beta",
				kind: "child",
				sessionFile: betaPath,
				createdAt: new Date(0).toISOString(),
			},
		]);

		const mainDispose = vi.fn();
		const mockAdapter = (dispose: () => void): HubAgentAdapter =>
			({
				subscribeLiveEvents: () => () => {},
				dispose,
			}) as unknown as HubAgentAdapter;

		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			if (createN === 1) {
				return mockAdapter(mainDispose);
			}
			throw new Error("beta-adapter-fail");
		});

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await expect(runtime.ensureAgentStarted("beta")).rejects.toThrow(/beta-adapter-fail/);

		expect(createN).toBe(2);
		expect(mainDispose).not.toHaveBeenCalled();
		expect(runtime.getRootAgentRuntime().agentAdapter).toBeDefined();
		expect(runtime.getAgentHydrationStatus("beta")).toBe("error");

		await expect(runtime.stop()).resolves.toBeUndefined();
		await expect(runtime.stop()).resolves.toBeUndefined();
	});

	it("does not implicitly rehydrate an explicitly stopped child", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-manual-stop-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
		const childPath = getAgentSessionFile(cwd, "manual-stop");
		writeFileSync(childPath, `${headerLine("manual-stop-session", cwd)}\n`, "utf8");
		seedRegistryWithChild(cwd, {
			id: "manual-stop",
			kind: "child",
			sessionFile: childPath,
			createdAt: new Date(0).toISOString(),
		});

		const adapter = {
			subscribeLiveEvents: () => () => {},
			dispose: vi.fn(),
		} as unknown as HubAgentAdapter;
		const create = vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(adapter);

		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await runtime.ensureAgentStarted("manual-stop");
		expect(create).toHaveBeenCalledTimes(2);

		await runtime.stopChildAgent(MAIN_AGENT_ID, { agentId: "manual-stop" });
		expect(runtime.getAllMessagingAgentIds()).not.toContain("manual-stop");
		await expect(runtime.ensureAgentStarted("manual-stop", "socket")).resolves.toBeUndefined();
		expect(create).toHaveBeenCalledTimes(2);

		await runtime.startChildAgent(MAIN_AGENT_ID, { agentId: "manual-stop" });
		expect(create).toHaveBeenCalledTimes(3);
		await runtime.stop();
	});

	it("initializeAgentAdapter passes services and model through to HubAgentAdapter.create for main (not overridden by undefined base fields)", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "hub-rt-merge-order-"));
		const agentDir = mkdtempSync(join(tmpdir(), "hub-rt-merge-order-agent-"));
		tempDirs.push(workspaceDir, agentDir);
		initializeWorkspace(workspaceDir);

		const faux = registerFauxProvider({
			models: [{ id: "faux-merge", name: "Faux merge", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});

		const services = await createAgentSessionServices({
			cwd: workspaceDir,
			agentDir,
			authStorage,
			modelRegistry,
		});

		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		const createSpy = vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);

		const runtime = HubRuntime.open(workspaceDir);
		await runtime.initializeAgentAdapter({
			services,
			model: faux.getModel(),
		});

		expect(createSpy).toHaveBeenCalled();
		const opts = createSpy.mock.calls[0]![0]!;
		expect(opts.tools).toBe(runtime.getRootAgentRuntime().tools);
		expect(opts.model).toBe(faux.getModel());
		expect(opts.services).toBe(services);
	});

	it("stop() clears the agent runtime map (one-shot teardown; getRootAgentRuntime throws afterwards)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-orchestrator-oneshot-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await runtime.stop();
		expect(() => runtime.getRootAgentRuntime()).toThrow(/Unknown agent id: root/);
	});

	it("stop() clears subscribeAllSessionServiceEvents fanout state (no stale listener arrays)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hub-rt-fanout-stop-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(0);
		const u = runtime.subscribeAllSessionServiceEvents(() => {});
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(1);
		u();
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(0);
		runtime.subscribeAllSessionServiceEvents(() => {});
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(1);
		await runtime.stop();
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(0);
	});
});
