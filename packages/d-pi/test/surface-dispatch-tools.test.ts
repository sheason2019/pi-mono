import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setBuiltinContext } from "../src/surface/builtin-context.ts";
import { createDispatchBashTool, createDispatchReadTool } from "../src/surface/dispatch-tools.ts";
import type { DPiRemoteToolRequest, DPiRemoteToolResult } from "../src/surface/index.ts";

interface TextToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

interface RecordedLocalCall {
	toolCallId: string;
	params: unknown;
}

class RecordingRemoteExecutor {
	readonly calls: DPiRemoteToolRequest[] = [];
	result: DPiRemoteToolResult = {
		requestId: "remote-call",
		ok: true,
		result: { content: [{ type: "text", text: "remote ok" }], details: { remote: true } },
	};

	async executeRemoteTool(request: DPiRemoteToolRequest): Promise<DPiRemoteToolResult> {
		this.calls.push(request);
		return { ...this.result, requestId: request.requestId };
	}
}

function createRecordingLocalExecutor(calls: RecordedLocalCall[], toolName: string) {
	return async (toolCallId: string, params: Record<string, unknown>): Promise<TextToolResult> => {
		calls.push({ toolCallId, params });
		return { content: [{ type: "text", text: `local ${toolName}` }], details: { local: toolName } };
	};
}

function asTextToolResult(result: unknown): TextToolResult {
	return result as TextToolResult;
}

function setupContext(
	localCalls: RecordedLocalCall[],
	remoteExecutor: RecordingRemoteExecutor,
	sourceAgentName?: string,
) {
	setBuiltinContext({
		hubClient: {} as never,
		agentName: sourceAgentName ?? "root",
		localExecutors: {
			bash: createRecordingLocalExecutor(localCalls, "bash"),
			read: createRecordingLocalExecutor(localCalls, "read"),
		},
		remoteExecutor,
		getReloadFn: () => undefined,
		getReloadDetails: () => ({}),
	});
}

describe("d-pi surface dispatch tools", () => {
	it("keeps surface dispatch tools independent from extension runtime APIs", async () => {
		const sourcePath = fileURLToPath(new URL("../src/surface/dispatch-tools.ts", import.meta.url));
		const source = await readFile(sourcePath, "utf8");

		expect(source).not.toContain("defineTool");
		expect(source).not.toContain("HubChannel");
		expect(source).not.toContain("ExtensionAPI");
	});

	describe("dispatch_bash", () => {
		it("creates a dispatch_bash tool", () => {
			const localCalls: RecordedLocalCall[] = [];
			setupContext(localCalls, new RecordingRemoteExecutor());
			const tool = createDispatchBashTool();

			expect(tool.name).toBe("dispatch_bash");
			expect(tool.label).toBe("Dispatch bash");
		});

		it("runs local executor without connect_id and strips connect_id from native params", async () => {
			const localCalls: RecordedLocalCall[] = [];
			setupContext(localCalls, new RecordingRemoteExecutor());
			const tool = createDispatchBashTool();

			const result = asTextToolResult(
				await tool.execute("call-local", {
					command: "pwd",
					connect_id: undefined,
				}),
			);

			expect(localCalls).toEqual([{ toolCallId: "call-local", params: { command: "pwd" } }]);
			expect(result).toEqual({ content: [{ type: "text", text: "local bash" }], details: { local: "bash" } });
		});

		it("runs remote executor with connect_id", async () => {
			const localCalls: RecordedLocalCall[] = [];
			const remoteExecutor = new RecordingRemoteExecutor();
			setupContext(localCalls, remoteExecutor, "root");
			const tool = createDispatchBashTool();

			const result = asTextToolResult(
				await tool.execute("remote-call", {
					command: "ls",
					connect_id: "connect-1",
				}),
			);

			expect(remoteExecutor.calls).toEqual([
				{
					requestId: "remote-call",
					connectId: "connect-1",
					toolName: "bash",
					params: { command: "ls" },
					sourceAgentName: "root",
				},
			]);
			expect(result).toEqual({ content: [{ type: "text", text: "remote ok" }], details: { remote: true } });
		});

		it("returns isError when remote execution returns ok false", async () => {
			const localCalls: RecordedLocalCall[] = [];
			const remoteExecutor = new RecordingRemoteExecutor();
			remoteExecutor.result = { requestId: "remote-call", ok: false, error: "client offline" };
			setupContext(localCalls, remoteExecutor);
			const tool = createDispatchBashTool();

			const result = asTextToolResult(
				await tool.execute("remote-call", {
					command: "echo hi",
					connect_id: "connect-2",
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.content.map((part) => part.text).join("\n")).toContain("client offline");
		});
	});

	describe("dispatch_read", () => {
		it("creates a dispatch_read tool", () => {
			const localCalls: RecordedLocalCall[] = [];
			setupContext(localCalls, new RecordingRemoteExecutor());
			const tool = createDispatchReadTool();

			expect(tool.name).toBe("dispatch_read");
			expect(tool.label).toBe("Dispatch read");
		});

		it("runs local executor without connect_id and strips connect_id from native params", async () => {
			const localCalls: RecordedLocalCall[] = [];
			setupContext(localCalls, new RecordingRemoteExecutor());
			const tool = createDispatchReadTool();

			const result = asTextToolResult(
				await tool.execute("call-local", {
					path: "/tmp/file.txt",
					connect_id: undefined,
				}),
			);

			expect(localCalls).toEqual([{ toolCallId: "call-local", params: { path: "/tmp/file.txt" } }]);
			expect(result).toEqual({ content: [{ type: "text", text: "local read" }], details: { local: "read" } });
		});

		it("runs remote executor with connect_id", async () => {
			const localCalls: RecordedLocalCall[] = [];
			const remoteExecutor = new RecordingRemoteExecutor();
			setupContext(localCalls, remoteExecutor, "root");
			const tool = createDispatchReadTool();

			const result = asTextToolResult(
				await tool.execute("remote-call", {
					path: "/tmp/image.png",
					connect_id: "connect-1",
				}),
			);

			expect(remoteExecutor.calls).toEqual([
				{
					requestId: "remote-call",
					connectId: "connect-1",
					toolName: "read",
					params: { path: "/tmp/image.png" },
					sourceAgentName: "root",
				},
			]);
			expect(result).toEqual({ content: [{ type: "text", text: "remote ok" }], details: { remote: true } });
		});

		it("returns isError when remote execution returns ok false", async () => {
			const localCalls: RecordedLocalCall[] = [];
			const remoteExecutor = new RecordingRemoteExecutor();
			remoteExecutor.result = { requestId: "remote-call", ok: false, error: "file not found" };
			setupContext(localCalls, remoteExecutor);
			const tool = createDispatchReadTool();

			const result = asTextToolResult(
				await tool.execute("remote-call", {
					path: "/tmp/missing.txt",
					connect_id: "connect-2",
				}),
			);

			expect(result.isError).toBe(true);
			expect(result.content.map((part) => part.text).join("\n")).toContain("file not found");
		});
	});
});
