import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createDPiDispatchTools,
	type DPiDispatchLocalExecutors,
	type DPiDispatchNativeToolName,
} from "../src/surface/dispatch-tools.ts";
import type { DPiRemoteToolRequest, DPiRemoteToolResult } from "../src/surface/index.ts";
import type { DPiTool } from "../src/surface/tool-surface.ts";

interface TextToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

interface RecordedLocalCall {
	toolName: DPiDispatchNativeToolName;
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

const createValueSchema = () =>
	Type.Object({
		value: Type.String(),
	});

const parameterSchemas: Record<DPiDispatchNativeToolName, ReturnType<typeof Type.Object>> = {
	bash: createValueSchema(),
	read: createValueSchema(),
	ls: createValueSchema(),
	grep: createValueSchema(),
	find: createValueSchema(),
	write: createValueSchema(),
	edit: createValueSchema(),
};

function createRecordingLocalExecutors(calls: RecordedLocalCall[]): DPiDispatchLocalExecutors {
	const createExecutor =
		(toolName: DPiDispatchNativeToolName) =>
		async (toolCallId: string, params: Record<string, unknown>): Promise<TextToolResult> => {
			calls.push({ toolName, toolCallId, params });
			return { content: [{ type: "text", text: `local ${toolName}` }], details: { local: toolName } };
		};

	return {
		bash: createExecutor("bash"),
		read: createExecutor("read"),
		ls: createExecutor("ls"),
		grep: createExecutor("grep"),
		find: createExecutor("find"),
		write: createExecutor("write"),
		edit: createExecutor("edit"),
	};
}

function getTool(tools: DPiTool[], name: string): DPiTool {
	const tool = tools.find((item) => item.name === name);
	if (!tool) {
		throw new Error(`Missing tool ${name}`);
	}
	return tool;
}

function asTextToolResult(result: unknown): TextToolResult {
	return result as TextToolResult;
}

describe("d-pi surface dispatch tools", () => {
	it("keeps surface dispatch tools independent from extension runtime APIs", async () => {
		const sourcePath = fileURLToPath(new URL("../src/surface/dispatch-tools.ts", import.meta.url));
		const source = await readFile(sourcePath, "utf8");

		expect(source).not.toContain("defineTool");
		expect(source).not.toContain("HubChannel");
		expect(source).not.toContain("ExtensionAPI");
	});

	it("creates one dispatch tool for each native tool", () => {
		const tools = createDPiDispatchTools({
			localExecutors: createRecordingLocalExecutors([]),
			remoteExecutor: new RecordingRemoteExecutor(),
			parameterSchemas,
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"dispatch_bash",
			"dispatch_read",
			"dispatch_ls",
			"dispatch_grep",
			"dispatch_find",
			"dispatch_write",
			"dispatch_edit",
		]);
	});

	it("runs local executors without connect_id and strips connect_id from native params", async () => {
		const calls: RecordedLocalCall[] = [];
		const tools = createDPiDispatchTools({
			localExecutors: createRecordingLocalExecutors(calls),
			remoteExecutor: new RecordingRemoteExecutor(),
			parameterSchemas,
		});

		const result = asTextToolResult(
			await getTool(tools, "dispatch_bash").execute("call-local", {
				value: "pwd",
				connect_id: undefined,
			}),
		);

		expect(calls).toEqual([{ toolName: "bash", toolCallId: "call-local", params: { value: "pwd" } }]);
		expect(result).toEqual({ content: [{ type: "text", text: "local bash" }], details: { local: "bash" } });
	});

	it("runs remote executor with connect_id and returns the remote native tool result", async () => {
		const remoteExecutor = new RecordingRemoteExecutor();
		const tools = createDPiDispatchTools({
			localExecutors: createRecordingLocalExecutors([]),
			remoteExecutor,
			parameterSchemas,
			sourceAgentName: "root",
		});

		const result = asTextToolResult(
			await getTool(tools, "dispatch_read").execute("remote-call", {
				value: "/tmp/file.txt",
				connect_id: "connect-1",
			}),
		);

		expect(remoteExecutor.calls).toEqual([
			{
				requestId: "remote-call",
				connectId: "connect-1",
				toolName: "read",
				params: { value: "/tmp/file.txt" },
				sourceAgentName: "root",
			},
		]);
		expect(result).toEqual({ content: [{ type: "text", text: "remote ok" }], details: { remote: true } });
	});

	it("returns an isError tool result when remote execution returns ok false", async () => {
		const remoteExecutor = new RecordingRemoteExecutor();
		remoteExecutor.result = { requestId: "remote-call", ok: false, error: "client offline" };
		const tools = createDPiDispatchTools({
			localExecutors: createRecordingLocalExecutors([]),
			remoteExecutor,
			parameterSchemas,
		});

		const result = asTextToolResult(
			await getTool(tools, "dispatch_find").execute("remote-call", {
				value: "*.ts",
				connect_id: "connect-2",
			}),
		);

		expect(result.isError).toBe(true);
		expect(result.content.map((part) => part.text).join("\n")).toContain("client offline");
	});
});
