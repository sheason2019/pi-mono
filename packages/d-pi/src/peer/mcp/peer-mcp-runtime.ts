import { createHash } from "node:crypto";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	McpHost,
	type PeerConfigSnapshot,
	type ToolCallAckPayload,
	type ToolCallErrorPayload,
	type ToolCallRequestPayload,
	type ToolCallResultPayload,
	type ToolCallUpdatePayload,
} from "../../hub/index.js";

const MAX_RESOURCE_TOKEN_LENGTH = 24;

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

function safeResourceToken(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	if (safe.length === 0) {
		return `x_${shortHash(value)}`;
	}
	if (safe === value && safe.length <= MAX_RESOURCE_TOKEN_LENGTH) {
		return safe;
	}
	return `${safe.slice(0, MAX_RESOURCE_TOKEN_LENGTH)}_${shortHash(value)}`;
}

function remoteMcpResourceToken(peerId: string, resourceId: string): string {
	return safeResourceToken(`${peerId}:${resourceId}`);
}

function remoteMcpToolNameFromLocal(peerId: string, localMcpToolName: string): string | undefined {
	const match = /^mcp__([^_][^_]*)__([^_][\s\S]*)$/.exec(localMcpToolName);
	if (!match) {
		return undefined;
	}
	return `mcp__${remoteMcpResourceToken(peerId, match[1]!)}__${match[2]!}`;
}

export interface PeerMcpRuntimeHost {
	start(): Promise<void>;
	stop(): Promise<void>;
	getStatuses(): ReturnType<McpHost["getStatuses"]>;
	getConfigError(): ReturnType<McpHost["getConfigError"]>;
	getSharedCustomToolsArray(): ToolDefinition[];
}

export interface PeerMcpRuntimeSocket {
	emit(event: "tool:call_ack", payload: ToolCallAckPayload): void;
	emit(event: "tool:call_update", payload: ToolCallUpdatePayload): void;
	emit(event: "tool:call_result", payload: ToolCallResultPayload): void;
	emit(event: "tool:call_error", payload: ToolCallErrorPayload): void;
}

export interface PeerMcpRuntimeOptions {
	cwd: string;
	snapshot: PeerConfigSnapshot;
	host?: PeerMcpRuntimeHost;
}

function serversFromMcpRoot(root: unknown): unknown[] {
	if (Array.isArray(root)) {
		return root;
	}
	if (root && typeof root === "object" && Array.isArray((root as { servers?: unknown }).servers)) {
		return (root as { servers: unknown[] }).servers;
	}
	return [];
}

function mergePeerMcpConfig(snapshot: PeerConfigSnapshot): { servers: unknown[] } {
	return {
		servers: [...serversFromMcpRoot(snapshot.global?.mcp), ...serversFromMcpRoot(snapshot.cwdLayer?.mcp)],
	};
}

export class PeerMcpRuntime {
	private host: PeerMcpRuntimeHost | undefined;

	constructor(private readonly options: PeerMcpRuntimeOptions) {
		this.host = options.host;
	}

	async start(): Promise<void> {
		await this.requireHost().start();
	}

	async stop(): Promise<void> {
		await this.requireHost().stop();
	}

	getSnapshot() {
		const host = this.requireHost();
		const configError = host.getConfigError();
		return {
			servers: host.getStatuses(),
			...(configError !== undefined ? { configError } : {}),
		};
	}

	getRemoteToolNames(peerId: string): string[] {
		const names: string[] = [];
		for (const tool of this.requireHost().getSharedCustomToolsArray()) {
			const remoteName = remoteMcpToolNameFromLocal(peerId, tool.name);
			if (remoteName) {
				names.push(remoteName);
			}
		}
		return names;
	}

	async executeToolRequest(
		peerId: string,
		payload: ToolCallRequestPayload,
		socket: PeerMcpRuntimeSocket,
	): Promise<boolean> {
		const localTool = this.findLocalTool(peerId, payload.toolName);
		if (!localTool) {
			return false;
		}
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => {
			abortController.abort();
		}, payload.timeoutMs);
		try {
			socket.emit("tool:call_ack", { toolCallId: payload.toolCallId });
			const result = await localTool.execute(
				payload.toolCallId,
				payload.args as never,
				abortController.signal,
				(partialResult) => {
					socket.emit("tool:call_update", {
						toolCallId: payload.toolCallId,
						partialResult,
					});
				},
				{} as ExtensionContext,
			);
			socket.emit("tool:call_result", {
				toolCallId: payload.toolCallId,
				result,
			});
		} catch (error) {
			socket.emit("tool:call_error", {
				toolCallId: payload.toolCallId,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearTimeout(timeoutId);
		}
		return true;
	}

	private findLocalTool(peerId: string, remoteToolName: string): ToolDefinition | undefined {
		for (const tool of this.requireHost().getSharedCustomToolsArray()) {
			if (remoteMcpToolNameFromLocal(peerId, tool.name) === remoteToolName) {
				return tool;
			}
		}
		return undefined;
	}

	private requireHost(): PeerMcpRuntimeHost {
		this.host ??= new McpHost({
			cwd: this.options.cwd,
			customTools: [],
			configRoot: () => mergePeerMcpConfig(this.options.snapshot),
		});
		return this.host;
	}
}
