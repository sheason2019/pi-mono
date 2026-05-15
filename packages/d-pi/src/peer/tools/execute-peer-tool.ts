import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
} from "@sheason/pi-coding-agent";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents, ToolCallRequestPayload } from "../../hub/index.js";

type PeerToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

function isPeerToolName(toolName: string): toolName is PeerToolName {
	return ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(toolName);
}

export async function executePeerToolRequest(
	cwd: string,
	payload: ToolCallRequestPayload,
	socket: Socket<ServerToClientEvents, ClientToServerEvents>,
): Promise<void> {
	if (!isPeerToolName(payload.toolName)) {
		socket.emit("tool:call_error", {
			toolCallId: payload.toolCallId,
			message: `Unsupported peer tool: ${payload.toolName}`,
		});
		return;
	}

	const definitions = {
		read: createReadToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
	const definition = definitions[payload.toolName];
	const executionContext = {} as ExtensionContext;
	const abortController = new AbortController();
	const timeoutId = setTimeout(() => {
		abortController.abort();
	}, payload.timeoutMs);

	try {
		socket.emit("tool:call_ack", {
			toolCallId: payload.toolCallId,
		});
		const result = await definition.execute(
			payload.toolCallId,
			payload.args as never,
			abortController.signal,
			(partialResult) => {
				socket.emit("tool:call_update", {
					toolCallId: payload.toolCallId,
					partialResult,
				});
			},
			executionContext,
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
}
