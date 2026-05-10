import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import { createHubTools } from "../../src/hub/tools/index.js";
import { HOST_PEER_ID } from "../../src/hub/tools/peer-tools.js";

const tempDirs: string[] = [];
const extCtx = { notify: () => {} } as unknown as ExtensionContext;

function findTool(name: string, tools: ToolDefinition[]): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`Tool ${name} not found`);
	}
	return tool;
}

function createTools(cwd: string): ToolDefinition[] {
	return createHubTools({
		cwd,
		agentId: MAIN_AGENT_ID,
		peerRegistry: new PeerRegistry(),
		peerToolBridge: {
			executeTool: async () => {
				throw new Error("peer bridge should not be used for host tools");
			},
		} as never,
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("host peer tools", () => {
	it("does not expose the removed list_peers discovery tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "host-peer-list-"));
		tempDirs.push(cwd);
		expect(() => findTool("list_peers", createTools(cwd))).toThrow(/not found/);
	});

	it("executes read locally on the hub when peer-id is host", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "host-peer-read-"));
		tempDirs.push(cwd);
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "host.txt"), "hello from hub\n", "utf8");
		const read = findTool("read", createTools(cwd));

		const result = await read.execute(
			"tc-read",
			{ "peer-id": HOST_PEER_ID, path: "host.txt" },
			undefined,
			undefined,
			extCtx,
		);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("hello from hub");
	});

	it("executes bash locally on the hub when peer-id is host", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "host-peer-bash-"));
		tempDirs.push(cwd);
		const bash = findTool("bash", createTools(cwd));

		const result = await bash.execute(
			"tc-bash",
			{ "peer-id": HOST_PEER_ID, command: "printf HOST_BASH_OK" },
			undefined,
			undefined,
			extCtx,
		);

		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("HOST_BASH_OK");
	});

	it("extends the remote peer execution envelope from bash timeout", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "host-peer-remote-bash-timeout-"));
		tempDirs.push(cwd);
		const executeTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));
		const tools = createHubTools({
			cwd,
			agentId: MAIN_AGENT_ID,
			peerRegistry: new PeerRegistry(),
			peerToolBridge: { executeTool } as never,
		});
		const bash = findTool("bash", tools);

		await bash.execute(
			"tc-bash-timeout",
			{ "peer-id": "remote-peer", command: "sleep 120", timeout: 120 },
			undefined,
			undefined,
			extCtx,
		);

		expect(executeTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: "tc-bash-timeout",
				toolName: "bash",
				peerId: "remote-peer",
				args: { command: "sleep 120", timeout: 120 },
				timeoutMs: 125_000,
			}),
		);
	});
});
