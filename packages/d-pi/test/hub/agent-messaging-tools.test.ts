import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];
const MESSAGING_TOOL_NAMES = ["send_message_to_agent", "broadcast_message_to_agents"] as const;
const CHILD_ONLY = new Set<string>();

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

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function textResult(res: unknown): string {
	const r = res as { content: { type: string; text?: string }[] };
	return r.content.find((c) => c.type === "text")?.text ?? "";
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("agent messaging tools", () => {
	it("main and child runtimes include send_message_to_agent and broadcast_message_to_agents", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-tools-presence-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			enqueueFromAgent: vi.fn(),
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const mainNames = new Set(runtime.getRootAgentRuntime().tools.map((t) => t.name));
		for (const n of MESSAGING_TOOL_NAMES) {
			expect(mainNames.has(n), `main missing ${n}`).toBe(true);
		}
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "bg",
		})) as { content: { type: string; text: string }[] };
		const idMatch = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "",
		);
		expect(idMatch).toBeTruthy();
		const childId = idMatch![1]!;
		const childRt = runtime.getAgentRuntime(childId);
		const childNames = new Set(childRt.tools.map((t) => t.name));
		for (const n of MESSAGING_TOOL_NAMES) {
			expect(childNames.has(n), `child missing ${n}`).toBe(true);
		}
	});

	it("send_message_to_agent prepares JSON-encoded agentIds arrays from tool calls", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-json-array-ids-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const firstChildSubmit = vi.fn().mockResolvedValue(undefined);
		const secondChildSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n === 1 ? firstChildSubmit : n === 2 ? secondChildSubmit : vi.fn();
			n += 1;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const first = textResult(await spawnEx!({ mode: "spawn", name: "first", background: "b1" }));
		const second = textResult(await spawnEx!({ mode: "spawn", name: "second", background: "b2" }));
		const firstId = /"childId":\s*"([^"]+)"/.exec(first)![1]!;
		const secondId = /"childId":\s*"([^"]+)"/.exec(second)![1]!;
		const tool = runtime.getRootAgentRuntime().tools.find((entry) => entry.name === "send_message_to_agent");
		const prepared = tool?.prepareArguments?.({
			agentIds: JSON.stringify([firstId, secondId]),
			message: "json-array-message",
		});

		expect(prepared).toEqual({ agentIds: [firstId, secondId], message: "json-array-message" });
		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		const res = await sendEx!(prepared);
		expect(JSON.parse(textResult(res))).toEqual({ ok: true, queued: [firstId, secondId] });
		expect(firstChildSubmit).toHaveBeenCalledWith("root", "json-array-message");
		expect(secondChildSubmit).toHaveBeenCalledWith("root", "json-array-message");
	});

	it("child runtimes have messaging and tree management tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-child-no-chain-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const stub = {
			enqueueFromAgent: vi.fn(),
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter;
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue(stub);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "x",
		})) as { content: { type: string; text: string }[] };
		const idMatch = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "",
		);
		const childId = idMatch![1]!;
		const childRt = runtime.getAgentRuntime(childId);
		for (const n of MESSAGING_TOOL_NAMES) {
			expect(childRt.tools.some((t) => t.name === n)).toBe(true);
		}
		for (const n of CHILD_ONLY) {
			expect(
				childRt.tools.some((t) => t.name === n),
				`child must not have ${n}`,
			).toBe(false);
		}
	});

	it("send_message_to_agent main to child queues with agent/main metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-main-child-fu-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n++ === 0 ? mainSubmit : childSubmit;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		expect(sendEx).toBeDefined();
		await sendEx!({
			agentIds: childId,
			message: "hello-from-main",
		});
		expect(mainSubmit).not.toHaveBeenCalled();
		expect(childSubmit).toHaveBeenCalledWith("root", "hello-from-main");
	});

	it("send_message_to_agent flushes the target queue when requested", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-main-child-flush-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		const childFlush = vi.fn().mockResolvedValue({ flushed: true, messages: 1 });
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const isMain = n++ === 0;
			return {
				enqueueFromAgent: isMain ? mainSubmit : childSubmit,
				flushInputQueue: isMain ? vi.fn() : childFlush,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);

		const result = await sendEx!({
			agentIds: childId,
			message: "urgent-from-main",
			flush: true,
		});

		expect(mainSubmit).not.toHaveBeenCalled();
		expect(childSubmit).toHaveBeenCalledWith("root", "urgent-from-main");
		expect(childFlush).toHaveBeenCalledOnce();
		expect(JSON.parse(textResult(result))).toEqual({
			ok: true,
			queued: [childId],
			flush: [{ agentId: childId, flushed: true, messages: 1 }],
		});
	});

	it("send_message_to_agent child to root queues with agent/<child> metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-child-main-steer-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n++ === 0 ? mainSubmit : childSubmit;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		const childSend = findToolExecute("send_message_to_agent", runtime.getAgentRuntime(childId).tools);
		await childSend!({
			agentIds: MAIN_AGENT_ID,
			message: "steer-please",
		});
		expect(childSubmit).not.toHaveBeenCalled();
		expect(mainSubmit).toHaveBeenCalledWith(childId, "steer-please");
	});

	it("dedupes multiple targets and rejects unknown id before any submit", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-dedupe-unknown-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n++ === 0 ? mainSubmit : childSubmit;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		const res = await sendEx!({
			agentIds: [childId, childId, "definitely-missing"],
			message: "m",
		});
		const text = textResult(res);
		expect(text.toLowerCase()).toMatch(/unknown|not found/);
		expect(childSubmit).not.toHaveBeenCalled();
		expect(mainSubmit).not.toHaveBeenCalled();
	});

	it("rejects self-target (main messaging main) to avoid loops", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-self-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			enqueueFromAgent: mainSubmit,
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		const res = await sendEx!({ agentIds: [MAIN_AGENT_ID], message: "x" });
		expect(textResult(res).toLowerCase()).toMatch(/self/);
		expect(mainSubmit).not.toHaveBeenCalled();
	});

	it("broadcast_message_to_agents sends to all agents except sender", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-broadcast-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n++ === 0 ? mainSubmit : childSubmit;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		const bc = findToolExecute("broadcast_message_to_agents", runtime.getRootAgentRuntime().tools);
		expect(bc).toBeDefined();
		const out = textResult(
			await bc!({
				message: "all-hands",
			}),
		);
		const parsed = JSON.parse(out) as { queued: string[] };
		expect(parsed.queued).toEqual([childId]);
		expect(childSubmit).toHaveBeenCalledTimes(1);
		expect(childSubmit).toHaveBeenCalledWith("root", "all-hands");
		expect(mainSubmit).not.toHaveBeenCalled();
	});

	it("always queues agent messages even when the target agent is already running", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-running-routing-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const mainSubmit = vi.fn().mockResolvedValue(undefined);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n++ === 0 ? mainSubmit : childSubmit;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		runtime.getAgentRuntime(childId).sessionService.setRunState(true);

		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		await sendEx!({ agentIds: childId, message: "queued-while-running" });
		expect(childSubmit).toHaveBeenLastCalledWith("root", "queued-while-running");

		await sendEx!({ agentIds: childId, message: "second-while-running" });
		expect(childSubmit).toHaveBeenLastCalledWith("root", "second-while-running");
	});

	it("broadcast with no other agents returns a clear no-recipients result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-broadcast-empty-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			enqueueFromAgent: vi.fn(),
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const bc = findToolExecute("broadcast_message_to_agents", runtime.getRootAgentRuntime().tools);
		const res = textResult(
			await bc!({
				message: "alone",
			}),
		);
		const parsed = JSON.parse(res) as { queued: string[]; recipients?: number };
		expect(parsed.queued).toEqual([]);
		expect(String(res).toLowerCase()).toMatch(/no|recipients|other|empty/);
	});

	it("hydrates a target runtime when its adapter is missing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-no-adapter-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const childSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n++ === 0 ? vi.fn() : childSubmit;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const spawnRes = (await (spawnEx as (a: { mode: "spawn"; background: string }) => Promise<unknown>)({
			mode: "spawn",
			background: "b",
		})) as {
			content: { type: string; text: string }[];
		};
		const childId = /"childId":\s*"([^"]+)"/.exec(
			(spawnRes.content.find((c) => c.type === "text") as { text: string }).text,
		)![1]!;
		runtime.getAgentRuntime(childId).agentAdapter = undefined;
		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		const tr = textResult(
			await sendEx!({
				agentIds: childId,
				message: "nope",
			}),
		);
		expect(JSON.parse(tr)).toEqual({ ok: true, queued: [childId] });
		expect(childSubmit).toHaveBeenCalledWith("root", "nope");
	});

	it("hydrates all target adapters before sending multi-target messages", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-no-partial-"));
		tempDirs.push(cwd);
		seedMainSessionWithDialog(cwd);
		const firstChildSubmit = vi.fn().mockResolvedValue(undefined);
		const secondChildSubmit = vi.fn().mockResolvedValue(undefined);
		let n = 0;
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async () => {
			const submit = n === 1 ? firstChildSubmit : n >= 2 ? secondChildSubmit : vi.fn();
			n += 1;
			return {
				enqueueFromAgent: submit,
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});
		const runtime = HubRuntime.open(cwd);
		await runtime.initializeAgentAdapter();
		const spawnEx = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
		const first = textResult(await spawnEx!({ mode: "spawn", name: "first", background: "b1" }));
		const second = textResult(await spawnEx!({ mode: "spawn", name: "second", background: "b2" }));
		const firstId = /"childId":\s*"([^"]+)"/.exec(first)![1]!;
		const secondId = /"childId":\s*"([^"]+)"/.exec(second)![1]!;
		runtime.getAgentRuntime(secondId).agentAdapter = undefined;

		const sendEx = findToolExecute("send_message_to_agent", runtime.getRootAgentRuntime().tools);
		const tr = textResult(
			await sendEx!({
				agentIds: [firstId, secondId],
				message: "must-not-partially-send",
			}),
		);

		expect(JSON.parse(tr)).toEqual({ ok: true, queued: [firstId, secondId] });
		expect(firstChildSubmit).toHaveBeenCalledWith("root", "must-not-partially-send");
		expect(secondChildSubmit).toHaveBeenCalledWith("root", "must-not-partially-send");
	});
});
