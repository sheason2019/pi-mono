import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createDPiHubActionsClient,
	type DPiHubActionRequest,
	type DPiHubActionsTransport,
	type DPiRemoteToolRequest,
	defineDPiCommand,
	defineDPiRemoteExecutor,
	defineDPiTool,
	dPiToolTextResult,
} from "../src/surface/index.ts";

const surfaceDir = fileURLToPath(new URL("../src/surface", import.meta.url));
const rootIndexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function readSurfaceSources(dir: string = surfaceDir): Promise<Array<{ path: string; source: string }>> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: Array<{ path: string; source: string }> = [];

	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await readSurfaceSources(path)));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push({ path, source: await readFile(path, "utf8") });
		}
	}

	return files;
}

describe("d-pi surface contracts", () => {
	it("keeps new surface sources independent from extension runtime APIs", async () => {
		const sources = await readSurfaceSources();

		expect(sources.map((file) => file.path)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("tool-surface.ts"),
				expect.stringContaining("command-surface.ts"),
				expect.stringContaining("hub-actions.ts"),
				expect.stringContaining("remote-executor.ts"),
			]),
		);
		expect(sources.map((file) => file.path)).not.toEqual(
			expect.arrayContaining([expect.stringContaining("message-surface.ts")]),
		);
		for (const file of sources) {
			expect(file.source).not.toContain("ExtensionAPI");
		}
	});

	it("defines AgentTool-compatible d-pi tools with a text result helper", async () => {
		const tool = defineDPiTool({
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => dPiToolTextResult(`echo:${params.text}`, { echoed: true }),
		});

		const result = await tool.execute("call-1", { text: "hello" });

		expect(tool.name).toBe("echo");
		expect(tool.parameters.type).toBe("object");
		expect(result).toEqual({
			content: [{ type: "text", text: "echo:hello" }],
			details: { echoed: true },
		});
	});

	it("keeps command contracts separate from tool contracts", async () => {
		const command = defineDPiCommand({
			name: "agent",
			description: "Select an agent",
			execute: ({ raw }) => ({ type: "showAgentSwitcher" as const, query: raw }),
		});

		const action = await command.execute({ raw: "child", args: ["child"], cwd: "/repo" });

		expect(action).toEqual({ type: "showAgentSwitcher", query: "child" });
		expect("parameters" in command).toBe(false);
		expect(command.execute.length).toBe(1);
	});

	it("sends typed hub action requests through a transport-backed client", async () => {
		const requests: DPiHubActionRequest[] = [];
		const transport: DPiHubActionsTransport = async (request) => {
			requests.push(request);
			return request.action === "getTeam" ? { rootName: "root", agents: [], executors: [] } : { ok: true };
		};
		const client = createDPiHubActionsClient(transport);

		await client.sendMessage({ fromAgentName: "root", toAgentName: "child", content: "hello", mode: "steer" });
		await client.getTeam();
		await client.dispatchRemoteTool({
			requestId: "remote-1",
			connectId: "connect-1",
			toolName: "bash",
			params: { command: "pwd" },
		});

		expect(requests).toEqual([
			{
				action: "sendMessage",
				payload: { fromAgentName: "root", toAgentName: "child", content: "hello", mode: "steer" },
			},
			{ action: "getTeam", payload: {} },
			{
				action: "dispatchRemoteTool",
				payload: {
					requestId: "remote-1",
					connectId: "connect-1",
					toolName: "bash",
					params: { command: "pwd" },
				},
			},
		]);
		await expect(readFile(rootIndexPath, "utf8")).resolves.toContain('export * from "./surface/index.ts";');
	});

	it("defines a remote executor boundary for fake tool request/result handling", async () => {
		const executor = defineDPiRemoteExecutor({
			executeRemoteTool: async (request: DPiRemoteToolRequest) => ({
				requestId: request.requestId,
				ok: true,
				result: { toolName: request.toolName, params: request.params },
			}),
		});

		const result = await executor.executeRemoteTool({
			requestId: "remote-1",
			connectId: "connect-1",
			toolName: "read",
			params: { path: "/tmp/file.txt" },
			sourceAgentName: "root",
		});

		expect(result).toEqual({
			requestId: "remote-1",
			ok: true,
			result: { toolName: "read", params: { path: "/tmp/file.txt" } },
		});
	});
});
