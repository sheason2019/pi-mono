import { type ChildProcessByStdio, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { GuestAgentMessagePayload } from "../hub/index.js";
import { PeerRuntime } from "../peer/runtime/peer-runtime.js";
import type { PeerInteractiveRuntime } from "../peer/tui/peer-interactive-mode.js";
import type { PeerThinkingLevel } from "../peer/types.js";
import type { AcpClientRuntimeOptions } from "./acp-client-runtime.js";
import { AcpClientRuntime } from "./acp-client-runtime.js";
import { AcpGuestProjection } from "./acp-guest-projection.js";
import type { GuestAcpCliOptions } from "./cli-args.js";

export class GuestAcpRuntime implements PeerInteractiveRuntime {
	private readonly peerRuntime: PeerRuntime;
	private readonly acpRuntime: AcpClientRuntime;
	private readonly projection: AcpGuestProjection;
	private readonly acpProcess?: ChildProcessByStdio<Writable, Readable, null>;
	private promptChain = Promise.resolve();
	private cancelRequested = false;

	readonly hello;
	readonly appState;
	readonly uiState;

	private constructor(
		peerRuntime: PeerRuntime,
		acpRuntime: AcpClientRuntime,
		projection: AcpGuestProjection,
		acpProcess?: ChildProcessByStdio<Writable, Readable, null>,
	) {
		this.peerRuntime = peerRuntime;
		this.acpRuntime = acpRuntime;
		this.projection = projection;
		this.acpProcess = acpProcess;
		this.hello = peerRuntime.hello;
		this.appState = peerRuntime.appState;
		this.uiState = peerRuntime.uiState;
	}

	static fromCommand(options: GuestAcpCliOptions & { version: string; cwd?: string }): GuestAcpRuntime {
		const cwd = options.cwd ?? process.cwd();
		const acpProcess = spawn(options.acpCommand, options.acpArgs, {
			cwd,
			env: createAcpProcessEnv(process.env),
			stdio: ["pipe", "pipe", "inherit"],
		});
		const stream = acp.ndJsonStream(
			Writable.toWeb(acpProcess.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(acpProcess.stdout) as ReadableStream<Uint8Array>,
		);
		let runtime: GuestAcpRuntime | undefined;
		const peerRuntime = new PeerRuntime({
			hubUrl: options.hubUrl,
			agentId: options.agentId,
			token: options.token,
			displayName: options.displayName,
			version: options.version,
			clientKind: "guest",
			executorEnabled: false,
			cwd,
			onHandshakeLog: (message) => {
				console.error(`[d-pi guest] ${message}`);
			},
			onGuestAgentMessage: async (payload) => {
				if (!runtime) {
					throw new Error("Guest ACP runtime is not initialized.");
				}
				await runtime.enqueueInboundAgentMessage(payload);
			},
		});
		const projection = new AcpGuestProjection({
			appState: peerRuntime.appState,
			agentId: options.agentId,
			cwd,
		});
		const acpRuntime = new AcpClientRuntime({
			stream,
			cwd,
			onSessionUpdate: (notification) => {
				projection.applySessionUpdate(notification);
			},
		});
		runtime = new GuestAcpRuntime(peerRuntime, acpRuntime, projection, acpProcess);
		return runtime;
	}

	static fromRuntimes(peerRuntime: PeerRuntime, acpOptions: AcpClientRuntimeOptions): GuestAcpRuntime {
		const projection = new AcpGuestProjection({
			appState: peerRuntime.appState,
			agentId: peerRuntime.hello.agentId ?? "guest",
			cwd: peerRuntime.hello.cwd ?? process.cwd(),
		});
		const originalOnSessionUpdate = acpOptions.onSessionUpdate;
		return new GuestAcpRuntime(
			peerRuntime,
			new AcpClientRuntime({
				...acpOptions,
				onSessionUpdate: async (notification) => {
					projection.applySessionUpdate(notification);
					await originalOnSessionUpdate?.(notification);
				},
			}),
			projection,
		);
	}

	async start(): Promise<void> {
		await this.peerRuntime.start();
		try {
			await this.acpRuntime.start();
		} catch (error) {
			await this.peerRuntime.stop().catch(() => {});
			throw error;
		}
	}

	async stop(): Promise<void> {
		await this.acpRuntime.stop();
		this.acpProcess?.kill();
		await this.peerRuntime.stop();
	}

	async queueWrite(text: string): Promise<void> {
		this.promptChain = this.promptChain
			.catch(() => {})
			.then(async () => {
				this.cancelRequested = false;
				this.projection.appendUserPrompt(text);
				await promptAcpWithProjection(this.acpRuntime, this.projection, text, () => this.cancelRequested);
			});
		await this.promptChain;
	}

	private async enqueueInboundAgentMessage(payload: GuestAgentMessagePayload): Promise<void> {
		this.promptChain = this.promptChain
			.catch(() => {})
			.then(async () => {
				this.cancelRequested = false;
				const prompt = this.projection.appendInboundAgentMessage(payload);
				await promptAcpWithProjection(this.acpRuntime, this.projection, prompt, () => this.cancelRequested);
			});
		await this.promptChain;
	}

	async queueFlush(): Promise<void> {}

	async submitPrompt(text: string): Promise<void> {
		await this.queueWrite(text);
	}

	async abort(): Promise<void> {
		this.cancelRequested = true;
		await this.acpRuntime.cancel();
		this.projection.completeTurn("cancelled");
	}

	async switchAgent(): Promise<void> {
		throw new Error("Agent switching is not available in guest ACP mode.");
	}

	async setModel(): Promise<void> {
		throw new Error("Model selection is not available in guest ACP mode.");
	}

	async setThinkingLevel(_level: PeerThinkingLevel): Promise<void> {
		throw new Error("Thinking level selection is not available in guest ACP mode.");
	}

	async invokeCommand(commandName: string): Promise<void> {
		if (commandName === "group") {
			return;
		}
		throw new Error(`/${commandName} is not available in guest ACP mode.`);
	}

	getSessionSources(): ReturnType<PeerRuntime["getSessionSources"]> {
		return Promise.resolve([]);
	}

	pauseSource(): ReturnType<PeerRuntime["pauseSource"]> {
		return Promise.resolve([]);
	}

	restartSource(): ReturnType<PeerRuntime["restartSource"]> {
		return Promise.resolve([]);
	}

	removeSource(): ReturnType<PeerRuntime["removeSource"]> {
		return Promise.resolve([]);
	}

	getMcpServers(): ReturnType<PeerRuntime["getMcpServers"]> {
		return Promise.resolve({ servers: [] });
	}

	pauseMcpServer(): ReturnType<PeerRuntime["pauseMcpServer"]> {
		return Promise.resolve([]);
	}

	restartMcpServer(): ReturnType<PeerRuntime["restartMcpServer"]> {
		return Promise.resolve([]);
	}

	removeMcpServer(): ReturnType<PeerRuntime["removeMcpServer"]> {
		return Promise.resolve([]);
	}
}

export function createAcpProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	delete next.D_PI_TOKEN;
	return next;
}

export function formatGuestAgentMessagePrompt(payload: GuestAgentMessagePayload): string {
	return [
		"[D-Pi agent message]",
		`from: ${payload.fromAgentId}`,
		`to: ${payload.toAgentId}`,
		`sent_at: ${payload.sentAt}`,
		"",
		payload.message,
	].join("\n");
}

async function promptAcpWithProjection(
	acpRuntime: AcpClientRuntime,
	projection: AcpGuestProjection,
	prompt: string,
	isCancelled: () => boolean,
): Promise<void> {
	try {
		const result = await acpRuntime.prompt(prompt);
		projection.completeTurn(isCancelled() ? "cancelled" : result.stopReason);
	} catch (error) {
		if (isCancelled()) {
			projection.completeTurn("cancelled");
			return;
		}
		projection.failTurn(error);
		throw error;
	}
}
