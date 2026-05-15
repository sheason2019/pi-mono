import type { AgentMessage } from "@sheason/pi-agent-core";
import type { AssistantMessage } from "@sheason/pi-ai";
import type { AgentToolResult } from "@sheason/pi-coding-agent";

export const LIVE_RENDER_EVENT_TYPES = [
	"message_start",
	"message_update",
	"message_end",
	"assistant_message_start",
	"assistant_message_update",
	"assistant_message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"status",
] as const;

export type LiveRenderEventType = (typeof LIVE_RENDER_EVENT_TYPES)[number];

export type LiveRenderEvent =
	| {
			type: "message_start" | "message_update" | "message_end";
			messageId: string;
			message: AgentMessage;
	  }
	| {
			type: "assistant_message_start" | "assistant_message_update" | "assistant_message_end";
			messageId: string;
			message: AssistantMessage;
	  }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
	  }
	| {
			type: "status";
			message: string;
	  };
