import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";

const MAX_TEXT_BYTES = 128_000;

export const NATIVE_TOOL_NAMES = ["bash", "read", "ls", "grep", "find", "write", "edit"] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

const BashParameters = Type.Object({
	command: Type.String(),
	timeout_ms: Type.Optional(Type.Number()),
});

const PathParameters = Type.Object({
	path: Type.Optional(Type.String()),
});

const ReadParameters = Type.Object({
	path: Type.String(),
});

const GrepParameters = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
});

const FindParameters = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
});

const WriteParameters = Type.Object({
	path: Type.String(),
	content: Type.String(),
});

const EditParameters = Type.Object({
	path: Type.String(),
	old_string: Type.String(),
	new_string: Type.String(),
});

export function buildNativeToolSet(cwd: string): AgentTool<TSchema, unknown>[] {
	return [
		createNativeTool(
			"bash",
			"Bash",
			"Run a shell command in the configured working directory.",
			BashParameters,
			(params, signal) => runBash(cwd, params, signal),
		),
		createNativeTool("edit", "Edit", "Replace one exact string occurrence in a file.", EditParameters, (params) =>
			runEdit(cwd, params),
		),
		createNativeTool("find", "Find", "List files whose relative path contains a pattern.", FindParameters, (params) =>
			runFind(cwd, params),
		),
		createNativeTool("grep", "Grep", "Search text files for a regular expression.", GrepParameters, (params) =>
			runGrep(cwd, params),
		),
		createNativeTool("ls", "List", "List files in a directory.", PathParameters, (params) => runLs(cwd, params)),
		createNativeTool("read", "Read", "Read a UTF-8 text file.", ReadParameters, (params) => runRead(cwd, params)),
		createNativeTool(
			"write",
			"Write",
			"Write a UTF-8 text file, creating parent directories.",
			WriteParameters,
			(params) => runWrite(cwd, params),
		),
	];
}

function createNativeTool<TParams extends TSchema>(
	name: string,
	label: string,
	description: string,
	parameters: TParams,
	execute: (
		params: Static<TParams>,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<unknown> & { isError?: boolean }>,
): AgentTool<TParams, unknown> {
	return {
		name,
		label,
		description,
		parameters,
		execute: async (_toolCallId, params, signal) => execute(params, signal),
	};
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
		content: [{ type: "text", text: truncateText(text) }],
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
	const content = await readFile(filePath, "utf8");
	return {
		content: [{ type: "text", text: truncateText(content) }],
		details: { path: filePath, bytes: Buffer.byteLength(content) },
	};
}

async function runWrite(cwd: string, params: Static<typeof WriteParameters>): Promise<AgentToolResult<unknown>> {
	const filePath = resolveInsideCwd(cwd, params.path);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, params.content, "utf8");
	return {
		content: [{ type: "text", text: `Wrote ${params.content.length} characters to ${params.path}` }],
		details: { path: filePath, bytes: Buffer.byteLength(params.content) },
	};
}

async function runEdit(
	cwd: string,
	params: Static<typeof EditParameters>,
): Promise<AgentToolResult<unknown> & { isError?: boolean }> {
	const filePath = resolveInsideCwd(cwd, params.path);
	const content = await readFile(filePath, "utf8");
	const first = content.indexOf(params.old_string);
	if (first === -1) {
		return errorResult(`String not found in ${params.path}`, { path: filePath });
	}
	if (content.indexOf(params.old_string, first + params.old_string.length) !== -1) {
		return errorResult(`String is not unique in ${params.path}`, { path: filePath });
	}
	const next = content.slice(0, first) + params.new_string + content.slice(first + params.old_string.length);
	await writeFile(filePath, next, "utf8");
	return {
		content: [{ type: "text", text: `Edited ${params.path}` }],
		details: { path: filePath },
	};
}

async function runLs(cwd: string, params: Static<typeof PathParameters>): Promise<AgentToolResult<unknown>> {
	const dir = resolveInsideCwd(cwd, params.path ?? ".");
	const entries = await readdir(dir, { withFileTypes: true });
	const names = entries
		.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
		.sort((left, right) => left.localeCompare(right));
	return {
		content: [{ type: "text", text: names.join("\n") }],
		details: { path: dir, entries: names.length },
	};
}

async function runFind(cwd: string, params: Static<typeof FindParameters>): Promise<AgentToolResult<unknown>> {
	const root = resolveInsideCwd(cwd, params.path ?? ".");
	const files = await listFiles(root);
	const matches = files
		.map((file) => relative(cwd, file))
		.filter((file) => file.includes(params.pattern))
		.sort((left, right) => left.localeCompare(right));
	return {
		content: [{ type: "text", text: matches.join("\n") }],
		details: { path: root, matches: matches.length },
	};
}

async function runGrep(
	cwd: string,
	params: Static<typeof GrepParameters>,
): Promise<AgentToolResult<unknown> & { isError?: boolean }> {
	const root = resolveInsideCwd(cwd, params.path ?? ".");
	const regex = new RegExp(params.pattern);
	const files = (await isDirectory(root)) ? await listFiles(root) : [root];
	const matches: string[] = [];
	for (const file of files) {
		if (!(await canRead(file))) {
			continue;
		}
		const content = await readFile(file, "utf8").catch(() => undefined);
		if (content === undefined) {
			continue;
		}
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index++) {
			if (regex.test(lines[index])) {
				matches.push(`${relative(cwd, file)}:${index + 1}:${lines[index]}`);
			}
		}
	}
	return {
		content: [{ type: "text", text: matches.join("\n") }],
		details: { path: root, matches: matches.length },
		...(matches.length > 0 ? {} : { isError: true }),
	};
}

async function listFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") {
			continue;
		}
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(path)));
		} else if (entry.isFile()) {
			files.push(path);
		}
	}
	return files;
}

async function isDirectory(path: string): Promise<boolean> {
	return (await stat(path)).isDirectory();
}

async function canRead(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
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

function errorResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> & { isError: true } {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}
