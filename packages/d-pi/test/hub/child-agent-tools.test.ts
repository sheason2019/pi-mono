import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import {
	getChildAgentDir,
	getChildAgentMcpConfigPath,
	getChildAgentSessionFile,
	getChildAgentSourcesConfigPath,
} from "../../src/hub/agents/child-agent-layout.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];
const CHAIN_TOOL_NAMES = new Set([
	"create_child_agent",
	"create_temporary_child_agent",
	"group",
	"update_child_agent",
	"rename_child_agent",
	"update_agent_description",
	"read_agent_history",
	"stop_child_agent",
	"start_child_agent",
	"remove_child_agent",
	"create_agent_token",
	"revoke_agent_token",
]);
const CHILD_SHARED_TOOL_NAMES = CHAIN_TOOL_NAMES;
const MAIN_ONLY_TOOL_NAMES = new Set<string>();

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

function readdirSyncSafe(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir);
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

/** Seeds main session with a user+assistant path so `createBranchedSession` can persist. */
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

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("tree child management tools", () => {
	it("root and child runtimes include tree management, token, group, and read tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-main-vs-child-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
		const runtime = HubRuntime.open(cwd, { logs });
		await runtime.initializeAgentAdapter();
		const mainNames = new Set(runtime.getRootAgentRuntime().tools.map((t) => t.name));
		for (const n of CHAIN_TOOL_NAMES) {
			expect(mainNames.has(n), `main missing ${n}`).toBe(true);
		}
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "bg for isolation check",
		})) as { content: { type: string; text: string }[] };
		const idMatch = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "",
		);
		expect(idMatch).toBeTruthy();
		const newChildId = idMatch![1]!;
		expect(logs.info).toHaveBeenCalledWith("child agent started", { agentId: newChildId });
		const childRt = runtime.getAgentRuntime(newChildId);
		const childNames = new Set(childRt.tools.map((t) => t.name));
		for (const n of CHILD_SHARED_TOOL_NAMES) {
			expect(childNames.has(n), `child missing ${n}`).toBe(true);
		}
		for (const n of MAIN_ONLY_TOOL_NAMES) {
			expect(childNames.has(n), `child must not have ${n}`).toBe(false);
		}
	});

	it("create_child_agent creates registry record, session file, runtime; background is visible in child session file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-spawn-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const exec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		expect(exec).toBeDefined();
		const res = (await exec!({
			mode: "spawn",
			name: "Test Spawn",
			description: "desc",
			background: "SEEDvisible background for spawn",
			extends: { mcp: ["host-mcp"], sources: true },
		})) as { content: { type: string; text: string }[] };
		const text = res.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/child-/);
		const idMatch = /"childId":\s*"([^"]+)"/.exec(text);
		expect(idMatch).toBeTruthy();
		const childId = idMatch![1]!;
		const parsed = JSON.parse(text) as { peerConnectCommand?: string; peerIdNote?: string };
		expect(parsed.peerConnectCommand).toBe(`d-pi peer --hub http://127.0.0.1:4317 --agent ${childId}`);
		expect(parsed.peerIdNote).toContain("--peer-id only sets the peer identity");
		const reg = runtime.agentRegistry.require(childId);
		expect(reg.kind).toBe("child");
		expect(reg.spawnMode).toBe("spawn");
		expect(reg.background).toBe("SEEDvisible background for spawn");
		expect(reg.sessionFile).toBe(getChildAgentSessionFile(cwd, childId));
		expect(existsSync(getChildAgentDir(cwd, childId))).toBe(true);
		expect(existsSync(join(getChildAgentDir(cwd, childId), "skills"))).toBe(true);
		expect(existsSync(join(getChildAgentDir(cwd, childId), "prompts"))).toBe(true);
		expect(existsSync(reg.sessionFile)).toBe(true);
		const raw = readFileSync(reg.sessionFile, "utf8");
		expect(raw).toContain("SEEDvisible background for spawn");
		expect(JSON.parse(readFileSync(getChildAgentMcpConfigPath(cwd, childId), "utf8"))).toEqual({
			extends: { host: { mcp: ["host-mcp"] } },
			servers: [],
		});
		expect(JSON.parse(readFileSync(getChildAgentSourcesConfigPath(cwd, childId), "utf8"))).toEqual({
			extends: { host: { sources: true } },
			sources: [],
		});
		expect(() => runtime.getAgentRuntime(childId)).not.toThrow();
	});

	it("child agents create direct descendants with parentId set to the caller", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-tree-grandchild-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const rootCreate = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const childText = textResult(await rootCreate!({ mode: "spawn", name: "child", background: "child task" }));
		const childId = JSON.parse(childText).childId as string;
		const childCreate = findToolExecute("create_child_agent", runtime.getAgentRuntime(childId).tools);

		const grandchildText = textResult(
			await childCreate!({ mode: "spawn", name: "grandchild", background: "grandchild task" }),
		);
		const grandchildId = JSON.parse(grandchildText).childId as string;

		expect(runtime.agentRegistry.require(childId).parentId).toBe(MAIN_AGENT_ID);
		expect(runtime.agentRegistry.require(grandchildId).parentId).toBe(childId);
		expect(runtime.agentRegistry.require(grandchildId).lifecycle).toBe("persistent");
	});

	it("temporary child agents report the last assistant result and delete themselves after idle", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-temp-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const parentEnqueue = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async (opts) => {
			return {
				enqueueFromAgent: opts.agentId === MAIN_AGENT_ID ? parentEnqueue : vi.fn(),
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const tempCreate = findToolExecute("create_temporary_child_agent", runtime.getRootAgentRuntime().tools);
		const tempText = textResult(await tempCreate!({ name: "temp", background: "do once" }));
		const tempId = JSON.parse(tempText).childId as string;
		const tempRuntime = runtime.getAgentRuntime(tempId);
		const sm = tempRuntime.sessionService.getSessionManager();
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done result" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		tempRuntime.sessionService.setRunState(true);
		tempRuntime.sessionService.setRunState(false);

		await vi.waitFor(() => {
			expect(parentEnqueue).toHaveBeenCalledWith(tempId, expect.stringContaining("done result"));
			expect(runtime.agentRegistry.get(tempId)).toBeUndefined();
			expect(() => runtime.getAgentRuntime(tempId)).toThrow();
		});
	});

	it("create_child_agent restarts sources when child inherits host sources so child gets its own source instance", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-source-reload-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const restartSources = vi.spyOn(runtime.sourceHost, "start").mockResolvedValue(undefined);
		const exec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);

		await exec!({ mode: "spawn", background: "source child", extends: { sources: ["lark"] } });

		expect(restartSources).toHaveBeenCalledTimes(1);
	});

	it("create_child_agent continues the child transcript so the child AI processes the background", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-spawn-wake-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const childContinue = vi.fn();
		let createCount = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createCount += 1;
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
				continueCurrentTranscript: createCount === 2 ? childContinue : vi.fn(),
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const exec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);

		await exec!({ mode: "spawn", background: "wake child from spawn" });

		expect(childContinue).toHaveBeenCalledTimes(1);
	});

	it("create_child_agent creates child session with main current branch path", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-fork-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const mainPath = getSessionFile(cwd);
		const mainRaw = readFileSync(mainPath, "utf8");
		expect(mainRaw).toContain("main-user-line");
		const exec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const res = (await exec!({
			mode: "fork",
			name: "forked",
			instructions: "post-fork user note",
		})) as { content: { type: string; text: string }[] };
		const text = res.content.find((c) => c.type === "text")?.text ?? "";
		const idMatch = /"childId":\s*"([^"]+)"/.exec(text);
		expect(idMatch).toBeTruthy();
		const childId = idMatch![1]!;
		const reg = runtime.agentRegistry.require(childId);
		expect(reg.spawnMode).toBe("fork");
		const childFile = getChildAgentSessionFile(cwd, childId);
		expect(reg.sessionFile).toBe(childFile);
		expect(existsSync(getChildAgentDir(cwd, childId))).toBe(true);
		expect(existsSync(join(getChildAgentDir(cwd, childId), "skills"))).toBe(true);
		expect(existsSync(join(getChildAgentDir(cwd, childId), "prompts"))).toBe(true);
		const childRaw = readFileSync(childFile, "utf8");
		expect(childRaw).toContain("main-user-line");
		expect(childRaw).toContain("main-assistant-line");
		expect(childRaw).toContain("post-fork user note");
	});

	it("create_child_agent continues the child transcript so the child AI processes instructions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-fork-wake-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const childContinue = vi.fn();
		let createCount = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createCount += 1;
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
				continueCurrentTranscript: createCount === 2 ? childContinue : vi.fn(),
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const exec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);

		await exec!({ mode: "fork", instructions: "wake child from fork" });

		expect(childContinue).toHaveBeenCalledTimes(1);
	});

	it("read_agent_history returns compact history and respects limit", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-read-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await spawnExec!({ mode: "spawn", background: "H0" })) as {
			content: { type: string; text: string }[];
		};
		const spawnText = spawnRes.content.find((c) => c.type === "text")?.text ?? "";
		const childId = /"childId":\s*"([^"]+)"/.exec(spawnText)![1]!;
		const readExec = findToolExecute("read_agent_history", runtime.getRootAgentRuntime().tools);
		const h1 = (await readExec!({ agentId: childId, limit: 5 })) as { content: { type: string; text: string }[] };
		const body = h1.content.find((c) => c.type === "text")?.text ?? "";
		expect(body).toContain("H0");
		const h2 = (await readExec!({ agentId: childId, limit: 1, includeToolResults: false })) as {
			content: { type: string; text: string }[];
		};
		const body2 = h2.content.find((c) => c.type === "text")?.text ?? "";
		const lineCount = body2.split("\n").filter((l) => l.trim().length > 0).length;
		expect(lineCount).toBeLessThanOrEqual(4);
	});

	it("group includes main and child with peer counts and run state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-list-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		await spawnExec!({ mode: "spawn", background: "x" });
		const listExec = findToolExecute("group", runtime.getRootAgentRuntime().tools);
		const res = (await listExec!({})) as { content: { type: string; text: string }[] };
		const text = res.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain(`"${MAIN_AGENT_ID}"`);
		expect(text).toMatch(/"kind":\s*"root"/);
		expect(text).toMatch(/"kind":\s*"child"/);
		expect(text).toMatch(/"peerCount"/);
		expect(text).toMatch(/"isRunning"/);
		expect(text).toContain("peerCount is connected d-pi peer client count only");
		expect(text).toContain("send_message_to_agent");
		expect(text).not.toContain("message_agent");
	});

	it("update_agent_description lets an agent update itself and descendants only", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-desc-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const childText = (await spawnExec!({ mode: "spawn", background: "child work" })) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(childText.content.find((c) => c.type === "text")?.text ?? "")![1]!;
		const mainUpdate = findToolExecute("update_agent_description", runtime.getRootAgentRuntime().tools);
		await mainUpdate!({ agentId: childId, description: "research specialist" });
		expect(runtime.agentRegistry.require(childId).description).toBe("research specialist");

		const childUpdate = findToolExecute("update_agent_description", runtime.getAgentRuntime(childId).tools);
		await childUpdate!({ description: "research specialist with fresh notes" });
		expect(runtime.agentRegistry.require(childId).description).toBe("research specialist with fresh notes");
		await expect(childUpdate!({ agentId: MAIN_AGENT_ID, description: "cannot edit root" })).rejects.toThrow(
			/root agent description|outside caller subtree/,
		);
	});

	it("update_child_agent lets the direct parent control a running child hub executor", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-update-executor-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const childText = textResult(await spawnExec!({ mode: "spawn", background: "child work" }));
		const childId = JSON.parse(childText).childId as string;

		const rootUpdate = findToolExecute("update_child_agent", runtime.getRootAgentRuntime().tools);
		expect(rootUpdate).toBeDefined();
		const updateText = textResult(await rootUpdate!({ agentId: childId, hubExecutor: "disabled" }));
		expect(JSON.parse(updateText)).toEqual(expect.objectContaining({ ok: true, childId, hubExecutor: "disabled" }));
		expect(runtime.agentRegistry.require(childId).hubExecutor).toBe("disabled");

		const childRead = findToolExecute("read", runtime.getAgentRuntime(childId).tools);
		await expect(childRead!({ "peer-id": "host", path: "package.json" })).rejects.toThrow(/Hub Executor is disabled/);

		const childUpdate = findToolExecute("update_child_agent", runtime.getAgentRuntime(childId).tools);
		await expect(childUpdate!({ agentId: childId, hubExecutor: "enabled" })).rejects.toThrow(/direct parent/);
	});

	it("update_child_agent rejects container executor config changes while the child is running", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-update-executor-running-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const childText = textResult(await spawnExec!({ mode: "spawn", background: "child work" }));
		const childId = JSON.parse(childText).childId as string;
		const rootUpdate = findToolExecute("update_child_agent", runtime.getRootAgentRuntime().tools);

		await expect(
			rootUpdate!({
				agentId: childId,
				executors: [{ id: "node-tools", type: "node-container", peerId: "node-tools", command: ["npx"] }],
			}),
		).rejects.toThrow(/must be stopped/);
	});

	it("rename_child_agent renames a stopped direct child and updates descendant parent links", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-rename-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const rootCreate = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const childText = textResult(await rootCreate!({ mode: "spawn", name: "Research Child", background: "child" }));
		const childId = JSON.parse(childText).childId as string;
		writeFileSync(getChildAgentSessionFile(cwd, childId), "child history\n", { flag: "a" });
		const childCreate = findToolExecute("create_child_agent", runtime.getAgentRuntime(childId).tools);
		const grandchildText = textResult(
			await childCreate!({ mode: "spawn", name: "Grand Child", background: "grandchild" }),
		);
		const grandchildId = JSON.parse(grandchildText).childId as string;
		const childStop = findToolExecute("stop_child_agent", runtime.getAgentRuntime(childId).tools);
		await childStop!({ agentId: grandchildId });
		const rootStop = findToolExecute("stop_child_agent", runtime.getRootAgentRuntime().tools);
		await rootStop!({ agentId: childId });

		const rename = findToolExecute("rename_child_agent", runtime.getRootAgentRuntime().tools);
		expect(rename).toBeDefined();
		const renamedText = textResult(await rename!({ agentId: childId, newAgentId: "Renamed Child" }));
		const renamed = JSON.parse(renamedText) as { ok: true; oldAgentId: string; childId: string; sessionFile: string };

		expect(renamed).toEqual(
			expect.objectContaining({
				ok: true,
				oldAgentId: childId,
				childId: "renamed-child",
				sessionFile: getChildAgentSessionFile(cwd, "renamed-child"),
			}),
		);
		expect(runtime.agentRegistry.get(childId)).toBeUndefined();
		expect(runtime.agentRegistry.require("renamed-child").sessionFile).toBe(
			getChildAgentSessionFile(cwd, "renamed-child"),
		);
		expect(runtime.agentRegistry.require(grandchildId).parentId).toBe("renamed-child");
		expect(existsSync(getChildAgentDir(cwd, childId))).toBe(false);
		expect(existsSync(getChildAgentDir(cwd, "renamed-child"))).toBe(true);
		expect(readFileSync(getChildAgentSessionFile(cwd, "renamed-child"), "utf8")).toContain("child history");
		expect(runtime.tryGetAgentRuntime(childId)).toBeUndefined();
		expect(runtime.tryGetAgentRuntime("renamed-child")).toBeUndefined();
	});

	it("rename_child_agent rejects running, duplicate, and non-direct-parent renames", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-rename-reject-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const rootCreate = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const firstId = JSON.parse(textResult(await rootCreate!({ mode: "spawn", name: "First", background: "first" })))
			.childId as string;
		const secondId = JSON.parse(
			textResult(await rootCreate!({ mode: "spawn", name: "Second", background: "second" })),
		).childId as string;
		const firstCreate = findToolExecute("create_child_agent", runtime.getAgentRuntime(firstId).tools);
		const grandchildId = JSON.parse(
			textResult(await firstCreate!({ mode: "spawn", name: "Grand", background: "grand" })),
		).childId as string;
		const rootRename = findToolExecute("rename_child_agent", runtime.getRootAgentRuntime().tools);
		const firstStop = findToolExecute("stop_child_agent", runtime.getAgentRuntime(firstId).tools);
		const rootStop = findToolExecute("stop_child_agent", runtime.getRootAgentRuntime().tools);

		await expect(rootRename!({ agentId: firstId, newAgentId: "renamed-first" })).rejects.toThrow(/must be stopped/);
		await firstStop!({ agentId: grandchildId });
		await rootStop!({ agentId: firstId });
		await rootStop!({ agentId: secondId });

		await expect(rootRename!({ agentId: firstId, newAgentId: secondId })).rejects.toThrow(/Duplicate agent id/);
		await expect(rootRename!({ agentId: grandchildId, newAgentId: "root-renamed-grand" })).rejects.toThrow(
			/direct parent/,
		);
	});

	it("stop_child_agent stops a child runtime but keeps registry, history, and allows start_child_agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-stop-start-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await spawnExec!({ mode: "spawn", background: "stop me later" })) as {
			content: { type: string; text: string }[];
		};
		const spawnText = spawnRes.content.find((c) => c.type === "text")?.text ?? "";
		const childId = /"childId":\s*"([^"]+)"/.exec(spawnText)![1]!;
		expect(runtime.tryGetAgentRuntime(childId)).toBeDefined();

		const stopExec = findToolExecute("stop_child_agent", runtime.getRootAgentRuntime().tools);
		const stopRes = (await stopExec!({ agentId: childId })) as { content: { type: string; text: string }[] };
		const stopBody = JSON.parse(stopRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			ok: boolean;
			childId: string;
			status: string;
		};
		expect(stopBody).toEqual(expect.objectContaining({ ok: true, childId, status: "stopped" }));
		expect(runtime.tryGetAgentRuntime(childId)).toBeUndefined();
		expect(runtime.agentRegistry.require(childId).kind).toBe("child");
		expect(existsSync(getChildAgentDir(cwd, childId))).toBe(true);

		const listExec = findToolExecute("group", runtime.getRootAgentRuntime().tools);
		const listRes = (await listExec!({})) as { content: { type: string; text: string }[] };
		const group = JSON.parse(listRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			agents: Array<{
				id: string;
				isWorking: boolean;
			}>;
		};
		const agents = group.agents;
		expect(agents.find((entry) => entry.id === childId)?.isWorking).toBe(false);

		const startExec = findToolExecute("start_child_agent", runtime.getRootAgentRuntime().tools);
		const startRes = (await startExec!({ agentId: childId })) as { content: { type: string; text: string }[] };
		const startBody = JSON.parse(startRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			ok: boolean;
			childId: string;
			status: string;
		};
		expect(startBody).toEqual(expect.objectContaining({ ok: true, childId, status: "started" }));
		expect(runtime.tryGetAgentRuntime(childId)).toBeDefined();
	});

	it("stop_child_agent aborts an active child adapter before disposing it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-stop-abort-before-dispose-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const calls: string[] = [];
		const mainStub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {
				calls.push("main.dispose");
			},
		} as unknown as HubAgentAdapter;
		const childStub = {
			subscribeLiveEvents: () => () => {},
			abort: async () => {
				calls.push("child.abort");
			},
			dispose: () => {
				calls.push("child.dispose");
			},
		} as unknown as HubAgentAdapter;
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			return createN === 1 ? mainStub : childStub;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await spawnExec!({ mode: "spawn", background: "active child" })) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(spawnRes.content.find((c) => c.type === "text")?.text ?? "")![1]!;
		runtime.getAgentRuntime(childId).sessionService.setRunState(true);

		const stopExec = findToolExecute("stop_child_agent", runtime.getRootAgentRuntime().tools);
		await stopExec!({ agentId: childId });

		expect(calls).toEqual(["child.abort", "child.dispose"]);
	});

	it("remove_child_agent removes registry and runtime but keeps child files by default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-remove-keep-files-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await spawnExec!({ mode: "spawn", background: "remove but keep files" })) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(spawnRes.content.find((c) => c.type === "text")?.text ?? "")![1]!;
		const childDir = getChildAgentDir(cwd, childId);
		expect(existsSync(childDir)).toBe(true);
		const childToken = runtime.authTokenStore.createScopedToken({
			name: "child guest",
			description: "Child lifecycle token",
			user: "Guest",
			purpose: "Review child",
			scopeRootAgentId: childId,
			createdByAgentId: childId,
		});

		const removeExec = findToolExecute("remove_child_agent", runtime.getRootAgentRuntime().tools);
		const removeRes = (await removeExec!({ agentId: childId })) as { content: { type: string; text: string }[] };
		const removeBody = JSON.parse(removeRes.content.find((c) => c.type === "text")?.text ?? "{}") as {
			ok: boolean;
			childId: string;
			status: string;
			filesDeleted: boolean;
		};
		expect(removeBody).toEqual(
			expect.objectContaining({ ok: true, childId, status: "removed", filesDeleted: false }),
		);
		expect(runtime.tryGetAgentRuntime(childId)).toBeUndefined();
		expect(runtime.agentRegistry.get(childId)).toBeUndefined();
		expect(existsSync(childDir)).toBe(true);
		expect(runtime.authTokenStore.authenticate(childToken.token)).toBeUndefined();
		const agentsFile = JSON.parse(readFileSync(getAgentsConfigPath(cwd), "utf8")) as { agents: { id: string }[] };
		expect(agentsFile.agents.map((entry) => entry.id)).toEqual([MAIN_AGENT_ID]);
	});

	it("remove_child_agent deletes child files when deleteFiles is true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-remove-delete-files-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await spawnExec!({ mode: "spawn", background: "remove and delete files" })) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(spawnRes.content.find((c) => c.type === "text")?.text ?? "")![1]!;
		const childDir = getChildAgentDir(cwd, childId);
		expect(existsSync(childDir)).toBe(true);

		const removeExec = findToolExecute("remove_child_agent", runtime.getRootAgentRuntime().tools);
		await removeExec!({ agentId: childId, deleteFiles: true });

		expect(runtime.agentRegistry.get(childId)).toBeUndefined();
		expect(existsSync(childDir)).toBe(false);
	});

	it("child lifecycle tools reject the root agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-reject-main-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		for (const toolName of ["stop_child_agent", "start_child_agent", "remove_child_agent"]) {
			const exec = findToolExecute(toolName, runtime.getRootAgentRuntime().tools);
			await expect(exec!({ agentId: MAIN_AGENT_ID })).rejects.toThrow(/root agent/);
		}
		const renameExec = findToolExecute("rename_child_agent", runtime.getRootAgentRuntime().tools);
		await expect(renameExec!({ agentId: MAIN_AGENT_ID, newAgentId: "renamed-root" })).rejects.toThrow(/root agent/);
	});

	it("create_child_agent: rolls back registry, session file, and runtime mapping when child adapter start fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-spawn-fail-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			if (createN === 1) {
				return stub;
			}
			throw new Error("child-adapter-fail");
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const fanoutListener = vi.fn();
		const unsubFanout = runtime.subscribeAllSessionServiceEvents(fanoutListener);
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(1);
		const agentsPath = getAgentsConfigPath(cwd);
		const preAgents = JSON.parse(readFileSync(agentsPath, "utf8")) as { agents: { id: string }[] };
		expect(preAgents.agents.length).toBe(1);
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		await expect(
			(spawnExec as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
				mode: "spawn",
				background: "x",
			}),
		).rejects.toThrow(/child-adapter-fail/);
		const postAgents = JSON.parse(readFileSync(agentsPath, "utf8")) as { agents: { id: string }[] };
		expect(postAgents.agents.length).toBe(1);
		expect(postAgents.agents[0]!.id).toBe(MAIN_AGENT_ID);
		const entries = readdirSyncSafe(join(cwd, ".pi-hub", "agents"));
		expect(entries.length).toBe(0);
		const listExec = findToolExecute("group", runtime.getRootAgentRuntime().tools);
		const listText = (await (listExec as (a: Record<string, never>) => Promise<unknown>)({})) as {
			content: { type: string; text: string }[];
		};
		const listBody = listText.content.find((c) => c.type === "text")?.text ?? "";
		expect(listBody).not.toMatch(/"kind":\s*"child"/);
		expect(runtime.tryGetAgentRuntime("child-1")).toBeUndefined();
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(1);
		runtime.getRootAgentRuntime().sessionService.setRunState(true);
		expect(fanoutListener).toHaveBeenCalledWith(
			MAIN_AGENT_ID,
			expect.objectContaining({ type: "run_state_changed" }),
		);
		unsubFanout();
		expect(runtime.getSessionFanoutEntryCountForTest()).toBe(0);
	});

	it("create_child_agent: rolls back when child adapter start fails (parameterized with spawn path)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-fork-fail-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		let createN = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			createN += 1;
			if (createN === 1) {
				return stub;
			}
			throw new Error("child-adapter-fail-fork");
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const agentsPath = getAgentsConfigPath(cwd);
		const exec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		await expect((exec as (a: { mode: "fork" }) => Promise<unknown>)({ mode: "fork" })).rejects.toThrow(
			/child-adapter-fail-fork/,
		);
		const postAgents = JSON.parse(readFileSync(agentsPath, "utf8")) as { agents: { id: string }[] };
		expect(postAgents.agents.length).toBe(1);
		const entries = readdirSyncSafe(join(cwd, ".pi-hub", "agents"));
		expect(entries.length).toBe(0);
		expect(runtime.tryGetAgentRuntime("child-1")).toBeUndefined();
	});

	it("read_agent_history includeToolResults false omits tool result and tool-call assistant lines", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-read-tool-filter-"));
		tempDirs.push(cwd);
		seedMainOnlyRegistry(cwd);
		const paths = initializeWorkspace(cwd).paths;
		const childId = "child-a";
		mkdirSync(getChildAgentDir(cwd, childId), { recursive: true });
		const childFile = getChildAgentSessionFile(cwd, childId);
		const sm = SessionManager.open(childFile, paths.workspaceDir, cwd);
		const t0 = Date.now();
		sm.appendMessage({ role: "user", content: "plain-user", timestamp: t0 });
		sm.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "with-tool" },
				{ type: "toolCall", id: "c1", name: "echo", arguments: { x: 1 } },
			],
			api: "test",
			provider: "p",
			model: "m",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: t0 + 1,
		});
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "echo",
			content: [{ type: "text", text: "tool-out" }],
			isError: false,
			timestamp: t0 + 2,
		});
		// materialize
		if (!existsSync(childFile)) {
			const h = sm.getHeader();
			if (h) {
				writeFileSync(childFile, `${[h, ...sm.getEntries()].map((e) => JSON.stringify(e)).join("\n")}\n`);
			}
		}
		const main: { id: string; kind: "root"; sessionFile: string; createdAt: string; lifecycle: "persistent" } = {
			id: MAIN_AGENT_ID,
			kind: "root",
			sessionFile: getSessionFile(cwd),
			createdAt: new Date(0).toISOString(),
			lifecycle: "persistent",
		};
		const child: {
			id: string;
			kind: "child";
			parentId: string;
			sessionFile: string;
			createdAt: string;
			lifecycle: "persistent";
		} = {
			id: childId,
			kind: "child",
			parentId: MAIN_AGENT_ID,
			sessionFile: childFile,
			createdAt: new Date(0).toISOString(),
			lifecycle: "persistent",
		};
		writeFileSync(
			getAgentsConfigPath(cwd),
			`${JSON.stringify({ version: 2 as const, agents: [main, child] }, null, 2)}\n`,
		);
		const runtimeStub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(runtimeStub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const readExec = findToolExecute("read_agent_history", runtime.getRootAgentRuntime().tools);
		const withTools = (await (readExec as (a: { agentId: string }) => Promise<unknown>)({ agentId: childId })) as {
			content: { type: string; text: string }[];
		};
		const withBody = withTools.content.find((c) => c.type === "text")?.text ?? "";
		expect(withBody).toContain("plain-user");
		expect(withBody).toContain("tool-out");
		const noTools = (await (readExec as (a: { agentId: string; includeToolResults: boolean }) => Promise<unknown>)({
			agentId: childId,
			includeToolResults: false,
		})) as { content: { type: string; text: string }[] };
		const noBody = noTools.content.find((c) => c.type === "text")?.text ?? "";
		expect(noBody).toContain("plain-user");
		expect(noBody).not.toContain("tool-out");
		expect(noBody).not.toContain("with-tool");
	});

	it("dynamically spawned child is in getAgentRuntime after hub socket start (no restart)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-tools-dynamic-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		await runtime.start({ host: "127.0.0.1", port: 0 });
		const fanoutListener = vi.fn();
		const unsubFanout = runtime.subscribeAllSessionServiceEvents(fanoutListener);
		const spawnExec = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const r = (await spawnExec!({ mode: "spawn", background: "after socket" })) as {
			content: { type: string; text: string }[];
		};
		const t = r.content.find((c) => c.type === "text")?.text ?? "";
		const childId = /"childId":\s*"([^"]+)"/.exec(t)![1]!;
		expect(() => runtime.getAgentRuntime(childId)).not.toThrow();
		runtime.getAgentRuntime(childId).sessionService.setRunState(true);
		expect(fanoutListener).toHaveBeenCalledWith(childId, expect.objectContaining({ type: "run_state_changed" }));
		unsubFanout();
		await runtime.stop();
	});
});
