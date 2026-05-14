import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { ROOT_AGENT_ID } from "../../src/hub/agents/types.js";
import { parseHubServeArgs, runServe } from "../../src/hub/commands/serve.js";
import { getHubLogFile, getHubLogLegacyFile } from "../../src/hub/tui/hub-log.js";
import type { HubServeMode, HubTuiModeDeps } from "../../src/hub/tui/hub-tui-mode.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";

const tempDirs: string[] = [];
const oldPort = process.env.PI_HUB_PORT;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	if (oldPort === undefined) {
		delete process.env.PI_HUB_PORT;
	} else {
		process.env.PI_HUB_PORT = oldPort;
	}
	vi.restoreAllMocks();
});

describe("runServe", () => {
	it("parses the explicit no-model safety override", () => {
		expect(parseHubServeArgs(["--allow-hub-no-model"])).toEqual({ allowHubNoModel: true });
		expect(parseHubServeArgs([])).toEqual({ allowHubNoModel: false });
	});

	it("starts headless mode with a runtime status view", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-serve-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const logFile = getHubLogLegacyFile(cwd);
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(
			logFile,
			`${JSON.stringify({ timestamp: 1_700_000_000_000, level: "info", message: "old persisted log" })}\n`,
			"utf8",
		);
		process.env.PI_HUB_PORT = "0";
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			diagnostics: [],
			getAvailableModels: async () => [{}],
			resourceLoader: {
				getSummary: () => ({ skills: 3, prompts: 2, themes: 1 }),
			},
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		let captured: HubTuiModeDeps | undefined;
		const stop = vi.fn().mockResolvedValue(undefined);
		const createHeadlessMode = vi.fn((deps: HubTuiModeDeps): HubServeMode => {
			captured = deps;
			return {
				run: async () => {
					const view = deps.getView();
					expect(view.status).toBe("running");
					expect(view.workspace).toBe(cwd);
					expect(view.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
					expect(view.agents.some((agent) => agent.id === ROOT_AGENT_ID)).toBe(true);
					expect(view.resources.skills).toBe(3);
					expect(view.resources.mcpStatusCounts).toEqual({ starting: 0, running: 0, stopped: 0, error: 0 });
					expect(view.resources.sourceStatusCounts).toEqual({ starting: 0, running: 0, stopped: 0, error: 0 });
					expect(view.logs.some((entry) => entry.message === "old persisted log")).toBe(true);
					expect(view.logs.some((entry) => entry.message.includes("已监听"))).toBe(true);
					expect(view.hubVersion).toBeDefined();
					return 0;
				},
				stop,
			};
		});

		await expect(runServe(cwd, { createHeadlessMode })).resolves.toBe(0);

		expect(createHeadlessMode).toHaveBeenCalledTimes(1);
		expect(captured).toBeDefined();
		expect(stop).toHaveBeenCalledTimes(1);
		const rawLog = readFileSync(getHubLogFile(cwd), "utf8");
		expect(rawLog).toContain("hub启动: 初始化日志");
	});

	it("refuses to start when the hub has no available models by default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-serve-no-model-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		process.env.PI_HUB_PORT = "0";
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			diagnostics: [],
			getAvailableModels: async () => [],
			resourceLoader: {
				getSummary: () => ({ skills: 0, prompts: 0, themes: 0 }),
			},
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const createHeadlessMode = vi.fn((): HubServeMode => {
			return {
				run: async () => 0,
				stop: vi.fn().mockResolvedValue(undefined),
			};
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runServe(cwd, { createHeadlessMode })).resolves.toBe(1);

		expect(createHeadlessMode).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(expect.stringContaining("--allow-hub-no-model"));
	});

	it("allows starting without hub models when explicitly requested", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-serve-allow-no-model-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		process.env.PI_HUB_PORT = "0";
		vi.spyOn(HubAgentAdapter, "create").mockResolvedValue({
			diagnostics: [],
			getAvailableModels: async () => [],
			resourceLoader: {
				getSummary: () => ({ skills: 0, prompts: 0, themes: 0 }),
			},
			subscribeLiveEvents: () => () => {},
			dispose: () => {},
		} as unknown as HubAgentAdapter);
		const createHeadlessMode = vi.fn((): HubServeMode => {
			return {
				run: async () => 0,
				stop: vi.fn().mockResolvedValue(undefined),
			};
		});

		await expect(runServe(cwd, { allowHubNoModel: true, createHeadlessMode })).resolves.toBe(0);

		expect(createHeadlessMode).toHaveBeenCalledTimes(1);
	});
});
