import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentToolDefinition } from "../agent-definition.ts";
import { defineTool } from "../agent-definition.ts";

const MAX_TEXT_BYTES = 128_000;

const BashParameters = Type.Object({
	command: Type.String(),
	timeout_ms: Type.Optional(Type.Number()),
});

const ReadParameters = Type.Object({
	path: Type.String(),
});

export function buildNativeToolSet(cwd: string): AgentToolDefinition[] {
	return [
		defineTool({
			name: "bash",
			label: "Bash",
			description: "Run a shell command in the configured working directory.",
			parameters: BashParameters,
			execute: async (_toolCallId, params, signal) => runBash(cwd, params as Static<typeof BashParameters>, signal),
		}),
		defineTool({
			name: "read",
			label: "Read",
			description: "Read a file as text or image.",
			parameters: ReadParameters,
			execute: async (_toolCallId, params) => runRead(cwd, params as Static<typeof ReadParameters>),
		}),
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
		const isUnix = platform() !== "win32";
		const child = spawn(shell, ["-lc", command], {
			cwd,
			detached: isUnix,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let resolved = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const resolveOnce = (code: number) => {
			if (resolved) return;
			resolved = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (aborted) {
				resolvePromise({ exitCode: 1, stdout, stderr: stderr || "Command aborted by user" });
			} else if (timedOut) {
				resolvePromise({ exitCode: code || 1, stdout, stderr: stderr || `Command timed out after ${timeoutMs}ms` });
			} else {
				resolvePromise({ exitCode: code, stdout, stderr });
			}
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout) > MAX_TEXT_BYTES * 2) {
				stdout = stdout.slice(0, MAX_TEXT_BYTES);
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (Buffer.byteLength(stderr) > MAX_TEXT_BYTES * 2) {
				stderr = stderr.slice(0, MAX_TEXT_BYTES);
				child.kill("SIGKILL");
			}
		});

		child.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ABORT_ERR") return;
			if (!resolved) {
				stderr = err.message;
				resolveOnce(1);
			}
		});

		child.on("close", (code: number | null) => {
			resolveOnce(code ?? 1);
		});

		if (timeoutMs) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				killProcessTree(child.pid, isUnix);
			}, timeoutMs);
		}

		if (signal) {
			const onAbort = () => {
				aborted = true;
				killProcessTree(child.pid, isUnix);
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
				child.once("close", () => signal.removeEventListener("abort", onAbort));
			}
		}
	});
}

function killProcessTree(pid: number | undefined, isUnix: boolean): void {
	if (pid === undefined) return;
	try {
		if (isUnix) {
			process.kill(-pid, "SIGTERM");
			setTimeout(() => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// already exited
				}
			}, 500);
		} else {
			process.kill(pid, "SIGKILL");
		}
	} catch {
		// Process may already be gone
	}
}

async function runRead(cwd: string, params: Static<typeof ReadParameters>): Promise<AgentToolResult<unknown>> {
	const filePath = resolvePath(cwd, params.path);
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

	if (imageExts.includes(ext)) {
		const data = await readFile(filePath);
		const mimeType = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
		return {
			content: [{ type: "image", data: data.toString("base64"), mimeType } as ImageContent],
			details: { path: filePath, bytes: data.length },
		};
	}

	const content = await readFile(filePath, "utf8");
	return {
		content: [{ type: "text", text: truncateText(content) } as TextContent],
		details: { path: filePath, bytes: Buffer.byteLength(content) },
	};
}

function resolvePath(cwd: string, path: string): string {
	return resolve(cwd, path);
}

function truncateText(text: string): string {
	const bytes = Buffer.byteLength(text);
	if (bytes <= MAX_TEXT_BYTES) {
		return text;
	}
	return `${text.slice(0, MAX_TEXT_BYTES)}\n[truncated ${bytes - MAX_TEXT_BYTES} bytes]`;
}
