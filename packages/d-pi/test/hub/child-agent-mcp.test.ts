import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDefinition } from "@sheason/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { getChildAgentDir, getChildAgentSessionFile } from "../../src/hub/agents/child-agent-layout.js";
import type { AgentRecord } from "../../src/hub/agents/types.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import type { McpClientHandle } from "../../src/hub/mcp/mcp-client.js";
import { getMcpConfigPath } from "../../src/hub/mcp/mcp-config.js";
import type { McpServerConfig, McpToolSummary } from "../../src/hub/mcp/types.js";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";

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

function createStubClient(partial: Partial<Client> & { callTool: Client["callTool"] }): Client {
	return partial as Client;
}

function makeToolSummary(name: string): McpToolSummary {
	return { name, description: "d", inputSchema: { type: "object", properties: {} } };
}

function buildFakeHandle(transport: McpServerConfig["transport"], toolName: string): McpClientHandle {
	const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });
	const client = createStubClient({ callTool: callTool as Client["callTool"] });
	return {
		client,
		capabilities: {
			tools: [makeToolSummary(toolName)],
			resources: [],
			prompts: [],
		},
		supportedCapabilities: { tools: true, resources: false, prompts: false },
		transport,
		close: vi.fn().mockResolvedValue(undefined),
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("child agent MCP", () => {
	it("loads child MCP config without inheriting host MCP tools by default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-agent-mcp-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const childId = "child";
		const childDir = getChildAgentDir(cwd, childId);
		mkdirSync(childDir, { recursive: true });
		const childSession = getChildAgentSessionFile(cwd, childId);
		writeFileSync(childSession, `${headerLine("child-session", cwd)}\n`, "utf8");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const main: AgentRecord = {
			id: MAIN_AGENT_ID,
			kind: "root",
			sessionFile: getSessionFile(cwd),
			createdAt: new Date(0).toISOString(),
			lifecycle: "persistent",
		};
		const child: AgentRecord = {
			id: childId,
			kind: "child",
			parentId: MAIN_AGENT_ID,
			sessionFile: childSession,
			createdAt: new Date(0).toISOString(),
			lifecycle: "persistent",
		};
		writeJson(getAgentsConfigPath(cwd), { version: 2, agents: [main, child] });
		writeJson(getMcpConfigPath(cwd), {
			servers: [{ resourceId: "mainmcp-id", name: "mainmcp", transport: "stdio", command: "main-cmd" }],
		});
		writeJson(join(childDir, "mcp.json"), {
			servers: [{ resourceId: "childmcp-id", name: "childmcp", transport: "stdio", command: "child-cmd" }],
		});
		const createClient = vi.fn().mockImplementation(async (cfg: McpServerConfig) => {
			return buildFakeHandle(cfg.transport, "echo");
		});
		const toolsByCall: ToolDefinition[][] = [];
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async (opts) => {
			toolsByCall.push(opts.tools);
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});

		const runtime = HubRuntime.open(cwd, { mcp: { createClient } });
		await runtime.initializeAgentAdapter();
		await runtime.ensureAgentStarted(childId);

		const mainToolNames = toolsByCall[0]!.map((tool) => tool.name);
		const childToolNames = toolsByCall[1]!.map((tool) => tool.name);
		expect(mainToolNames).toContain("mcp__mainmcp-id__echo");
		expect(mainToolNames).not.toContain("mcp__childmcp-id__echo");
		expect(childToolNames).toContain("mcp__childmcp-id__echo");
		expect(childToolNames).not.toContain("mcp__mainmcp-id__echo");
		expect(createClient).toHaveBeenCalledTimes(2);
	});

	it("inherits selected host MCP tools from child mcp extends", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "child-agent-mcp-extends-"));
		tempDirs.push(cwd);
		initializeWorkspace(cwd);
		const childId = "child";
		const childDir = getChildAgentDir(cwd, childId);
		mkdirSync(childDir, { recursive: true });
		const childSession = getChildAgentSessionFile(cwd, childId);
		writeFileSync(childSession, `${headerLine("child-session", cwd)}\n`, "utf8");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const main: AgentRecord = {
			id: MAIN_AGENT_ID,
			kind: "root",
			sessionFile: getSessionFile(cwd),
			createdAt: new Date(0).toISOString(),
			lifecycle: "persistent",
		};
		const child: AgentRecord = {
			id: childId,
			kind: "child",
			parentId: MAIN_AGENT_ID,
			sessionFile: childSession,
			createdAt: new Date(0).toISOString(),
			lifecycle: "persistent",
		};
		writeJson(getAgentsConfigPath(cwd), { version: 2, agents: [main, child] });
		writeJson(getMcpConfigPath(cwd), {
			servers: [
				{ resourceId: "keep-id", name: "keep", transport: "stdio", command: "keep-cmd" },
				{ resourceId: "drop-id", name: "drop", transport: "stdio", command: "drop-cmd" },
			],
		});
		writeJson(join(childDir, "mcp.json"), {
			extends: { host: { mcp: ["keep"] } },
			servers: [{ resourceId: "childmcp-id", name: "childmcp", transport: "stdio", command: "child-cmd" }],
		});
		const createClient = vi.fn().mockImplementation(async (cfg: McpServerConfig) => {
			return buildFakeHandle(cfg.transport, "echo");
		});
		const toolsByCall: ToolDefinition[][] = [];
		vi.spyOn(HubAgentAdapter, "create").mockImplementation(async (opts) => {
			toolsByCall.push(opts.tools);
			return {
				subscribeLiveEvents: () => () => {},
				dispose: () => {},
			} as unknown as HubAgentAdapter;
		});

		const runtime = HubRuntime.open(cwd, { mcp: { createClient } });
		await runtime.initializeAgentAdapter();
		await runtime.ensureAgentStarted(childId);

		const childToolNames = toolsByCall[1]!.map((tool) => tool.name);
		expect(childToolNames).toContain("mcp__keep-id__echo");
		expect(childToolNames).toContain("mcp__childmcp-id__echo");
		expect(childToolNames).not.toContain("mcp__drop-id__echo");
		expect(createClient).toHaveBeenCalledTimes(4);
	});
});
