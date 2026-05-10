import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { type AgentRecord, MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { NodeContainerExecutorLauncher, type SpawnProcess } from "../../src/hub/executors/container-executor.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { getAgentSessionFile, initializeWorkspace } from "../../src/hub/workspace.js";

const extCtx = { notify: () => {} } as unknown as ExtensionContext;

function findToolExecute(
	name: string,
	tools: ToolDefinition[],
): ((params: unknown) => ReturnType<NonNullable<ToolDefinition["execute"]>>) | undefined {
	const t = tools.find((x) => x.name === name) as ToolDefinition | undefined;
	if (!t) return undefined;
	return (params: unknown) =>
		t.execute("tc-container-1", params as never, undefined, undefined, extCtx) as ReturnType<
			NonNullable<ToolDefinition["execute"]>
		>;
}

function textResult(value: unknown): string {
	const payload = value as { content?: Array<{ type: string; text?: string }> };
	return payload.content?.find((part) => part.type === "text")?.text ?? "";
}

function createFakeProcess() {
	const proc = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
	proc.kill = vi.fn();
	return proc;
}

describe("NodeContainerExecutorLauncher", () => {
	it("starts a docker node container with hub peer environment and custom command", () => {
		const proc = createFakeProcess();
		const spawn = vi.fn<SpawnProcess>((_command, _args, _options) => proc);
		const launcher = new NodeContainerExecutorLauncher({ spawn });

		const handle = launcher.start({
			cwd: "/workspace/project",
			hubUrl: "http://127.0.0.1:4317",
			agentId: "child-a",
			executor: {
				id: "node-tools",
				type: "node-container",
				peerId: "node-tools",
				image: "node:22",
				command: ["npx", "d-pi", "peer"],
				token: "dpi_executor_token",
				env: { EXTRA: "1" },
				workdir: "/workspace/project",
				containerName: "d-pi-child-a-node-tools",
			},
		});

		expect(spawn).toHaveBeenCalledWith(
			"docker",
			[
				"run",
				"--rm",
				"--name",
				"d-pi-child-a-node-tools",
				"-e",
				"D_PI_TOKEN=dpi_executor_token",
				"-e",
				"D_PI_HUB_URL=http://127.0.0.1:4317",
				"-e",
				"D_PI_AGENT_ID=child-a",
				"-e",
				"D_PI_PEER_ID=node-tools",
				"-e",
				"EXTRA=1",
				"-w",
				"/workspace/project",
				"node:22",
				"npx",
				"d-pi",
				"peer",
			],
			{ cwd: "/workspace/project", stdio: ["ignore", "pipe", "pipe"] },
		);

		handle.stop();

		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("create_child_agent persists generated container executor tokens and starts the executor when serving", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-container-create-tool-"));
		try {
			initializeWorkspace(cwd);
			vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter);
			const proc = createFakeProcess();
			const spawn = vi.fn<SpawnProcess>((_command, _args, _options) => proc);
			const runtime = HubRuntime.open(cwd, { executors: { containerSpawn: spawn } });
			await runtime.initializeAgentAdapter();
			const address = await runtime.start({ host: "127.0.0.1", port: 0 });
			const create = findToolExecute("create_child_agent", runtime.getRootAgentRuntime().tools);
			expect(create).toBeDefined();

			const createText = textResult(
				await create!({
					mode: "spawn",
					name: "container child",
					background: "run in isolated executor",
					hubExecutor: "disabled",
					executors: [
						{
							id: "node-tools",
							type: "node-container",
							peerId: "node-tools",
							image: "node:22",
							command: ["npx", "d-pi", "peer"],
						},
					],
				}),
			);

			const childId = JSON.parse(createText).childId as string;
			const record = runtime.agentRegistry.require(childId);
			expect(record.hubExecutor).toBe("disabled");
			expect(record.executors?.[0]?.token).toMatch(/^dpi_/);
			expect(spawn).toHaveBeenCalledOnce();
			const dockerArgs = spawn.mock.calls[0]?.[1] ?? [];
			expect(dockerArgs).toContain(`D_PI_HUB_URL=http://127.0.0.1:${address.port}`);
			expect(dockerArgs).toContain(`D_PI_AGENT_ID=${childId}`);
			expect(dockerArgs).toContain(`D_PI_TOKEN=${record.executors?.[0]?.token}`);

			await runtime.stop();

			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("HubRuntime container executors", () => {
	it("starts configured child container executors after the hub socket starts and stops them on shutdown", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "d-pi-container-runtime-"));
		try {
			initializeWorkspace(cwd);
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			mkdirSync(join(cwd, ".pi-hub", "agents"), { recursive: true });
			const childSession = getAgentSessionFile(cwd, "child-a");
			writeFileSync(
				childSession,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date(0).toISOString(),
					cwd,
				})}\n`,
				"utf8",
			);
			const root: AgentRecord = {
				id: MAIN_AGENT_ID,
				kind: "root",
				sessionFile: getSessionFile(cwd),
				createdAt: new Date(0).toISOString(),
				lifecycle: "persistent",
				hubExecutor: "enabled",
			};
			const child: AgentRecord = {
				id: "child-a",
				kind: "child",
				parentId: MAIN_AGENT_ID,
				sessionFile: childSession,
				createdAt: new Date(0).toISOString(),
				lifecycle: "persistent",
				hubExecutor: "enabled",
				executors: [
					{
						id: "node-tools",
						type: "node-container",
						peerId: "node-tools",
						image: "node:22",
						command: ["npx", "d-pi", "peer"],
						token: "dpi_executor_token",
					},
				],
			};
			writeFileSync(getAgentsConfigPath(cwd), `${JSON.stringify({ version: 2, agents: [root, child] }, null, 2)}\n`);
			vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter);
			const proc = createFakeProcess();
			const spawn = vi.fn<SpawnProcess>((_command, _args, _options) => proc);
			const runtime = HubRuntime.open(cwd, { executors: { containerSpawn: spawn } });
			await runtime.initializeAgentAdapter();
			const address = await runtime.start({ host: "127.0.0.1", port: 0 });

			expect(spawn).toHaveBeenCalledOnce();
			expect(spawn.mock.calls[0]?.[1]).toContain(`D_PI_HUB_URL=http://127.0.0.1:${address.port}`);
			expect(spawn.mock.calls[0]?.[1]).toContain("D_PI_AGENT_ID=child-a");
			expect(spawn.mock.calls[0]?.[1]).toContain("D_PI_PEER_ID=node-tools");

			await runtime.stop();

			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
