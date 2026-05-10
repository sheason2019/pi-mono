import { type IOType, spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import process from "node:process";
import { PassThrough, type Stream } from "node:stream";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { markDetachedChildProcess, signalChildProcessTree } from "../processes/child-process-tree.js";

const CLOSE_GRACE_MS = 2_000;

export type DetachedStdioServerParameters = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	stderr?: IOType | Stream | number;
	cwd?: string;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * MCP's SDK stdio transport cannot request `detached: true`, so closing it only
 * kills the direct child. Sources like `lark-cli event` may leave grandchildren
 * alive; this transport owns an isolated process group and tears it down on close.
 */
export class DetachedStdioClientTransport implements Transport {
	private readonly readBuffer = new ReadBuffer();
	private readonly serverParams: DetachedStdioServerParameters;
	private readonly stderrStream: PassThrough | null;
	private childProcess: ReturnType<typeof nodeSpawn> | undefined;

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	constructor(server: DetachedStdioServerParameters) {
		this.serverParams = server;
		this.stderrStream = server.stderr === "pipe" || server.stderr === "overlapped" ? new PassThrough() : null;
	}

	async start(): Promise<void> {
		if (this.childProcess) {
			throw new Error("DetachedStdioClientTransport already started.");
		}
		await new Promise<void>((resolve, reject) => {
			const detached = process.platform !== "win32";
			const stdio: StdioOptions = ["pipe", "pipe", this.serverParams.stderr ?? "inherit"];
			const child = nodeSpawn(this.serverParams.command, this.serverParams.args ?? [], {
				cwd: this.serverParams.cwd,
				detached,
				env: {
					...getDefaultEnvironment(),
					...this.serverParams.env,
				},
				stdio,
				shell: false,
				windowsHide: true,
			});
			this.childProcess = detached ? markDetachedChildProcess(child) : child;
			child.once("error", (error) => {
				reject(error);
				this.onerror?.(error);
			});
			child.once("spawn", () => {
				resolve();
			});
			child.once("close", () => {
				this.childProcess = undefined;
				this.onclose?.();
			});
			child.stdin?.on("error", (error) => {
				this.onerror?.(error);
			});
			child.stdout?.on("data", (chunk: Buffer) => {
				this.readBuffer.append(chunk);
				this.processReadBuffer();
			});
			child.stdout?.on("error", (error) => {
				this.onerror?.(error);
			});
			if (this.stderrStream && child.stderr) {
				child.stderr.pipe(this.stderrStream);
			}
		});
	}

	get stderr(): Stream | null {
		if (this.stderrStream) {
			return this.stderrStream;
		}
		return this.childProcess?.stderr ?? null;
	}

	get pid(): number | null {
		return this.childProcess?.pid ?? null;
	}

	async close(): Promise<void> {
		const child = this.childProcess;
		if (!child) {
			this.readBuffer.clear();
			return;
		}
		this.childProcess = undefined;
		const closePromise = new Promise<void>((resolve) => {
			child.once("close", () => {
				resolve();
			});
		});
		try {
			child.stdin?.end();
		} catch {
			// ignore
		}
		await Promise.race([closePromise, delay(CLOSE_GRACE_MS)]);
		signalChildProcessTree(child, "SIGTERM");
		await Promise.race([closePromise, delay(CLOSE_GRACE_MS)]);
		signalChildProcessTree(child, "SIGKILL");
		this.readBuffer.clear();
	}

	async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		const stdin = this.childProcess?.stdin;
		if (!stdin) {
			throw new Error("Not connected");
		}
		const json = serializeMessage(message);
		if (stdin.write(json)) {
			return;
		}
		await new Promise<void>((resolve) => {
			stdin.once("drain", resolve);
		});
	}

	private processReadBuffer(): void {
		for (;;) {
			try {
				const message = this.readBuffer.readMessage();
				if (message === null) {
					break;
				}
				this.onmessage?.(message);
			} catch (error) {
				this.onerror?.(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}
}
