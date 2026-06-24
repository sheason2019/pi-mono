import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";

const MAX_TEXT_BYTES = 128_000;

const BashParameters = Type.Object({
	command: Type.String(),
	timeout_ms: Type.Optional(Type.Number()),
});

const ReadParameters = Type.Object({
	path: Type.String(),
});

export function buildNativeToolSet(cwd: string): AgentTool<TSchema, unknown>[] {
	return [
		{
			name: "bash",
			label: "Bash",
			description: "Run a shell command in the configured working directory.",
			parameters: BashParameters,
			execute: async (_toolCallId, params, signal) => runBash(cwd, params as Static<typeof BashParameters>, signal),
		} as AgentTool<typeof BashParameters, unknown>,
		{
			name: "read",
			label: "Read",
			description: "Read a file as text or image.",
			parameters: ReadParameters,
			execute: async (_toolCallId, params) => runRead(cwd, params as Static<typeof ReadParameters>),
		} as AgentTool<typeof ReadParameters, unknown>,
	];
}

async function runBash(
	cwd: string,
	params: Static<typeof BashParameters>,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown> & { isError?: boolean }> {
	const shell = process.env.SHELL || "/bin/sh";
	const startedAt = Date.now();
	const result = await execShell(shell, cwd, params.command, params.timeout_ms, signal);
	const text = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
	return {
		content: [{ type: "text", text: truncateText(text) } as TextContent],
		details: {
			exitCode: result.exitCode,
			stdout: truncateText(result.stdout),
			stderr: truncateText(result.stderr),
			durationMs: Date.now() - startedAt,
		},
		...(result.exitCode === 0 ? {} : { isError: true }),
	};
}

function execShell(
	shell: string,
	cwd: string,
	command: string,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = execFile(
			shell,
			["-lc", command],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: MAX_TEXT_BYTES,
				signal,
				timeout: timeoutMs,
			},
			(error, stdout, stderr) => {
				const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolvePromise({ exitCode, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		child.on("error", (error) => {
			resolvePromise({ exitCode: 1, stdout: "", stderr: error.message });
		});
	});
}

async function runRead(cwd: string, params: Static<typeof ReadParameters>): Promise<AgentToolResult<unknown>> {
	const filePath = resolveInsideCwd(cwd, params.path);
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

	if (imageExts.includes(ext)) {
		const data = await readFile(filePath);
		const mimeType = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
		const dataUrl = `data:${mimeType};base64,${data.toString("base64")}`;
		return {
			content: [{ type: "image", data: dataUrl, mimeType } as ImageContent],
			details: { path: filePath, bytes: data.length },
		};
	}

	const content = await readFile(filePath, "utf8");
	return {
		content: [{ type: "text", text: truncateText(content) } as TextContent],
		details: { path: filePath, bytes: Buffer.byteLength(content) },
	};
}

function resolveInsideCwd(cwd: string, path: string): string {
	const root = resolve(cwd);
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new Error(`Path escapes working directory: ${path}`);
	}
	return target;
}

function truncateText(text: string): string {
	const bytes = Buffer.byteLength(text);
	if (bytes <= MAX_TEXT_BYTES) {
		return text;
	}
	return `${text.slice(0, MAX_TEXT_BYTES)}\n[truncated ${bytes - MAX_TEXT_BYTES} bytes]`;
}
