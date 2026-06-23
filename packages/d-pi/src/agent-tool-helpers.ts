import { Type } from "typebox";
import type { AgentToolDefinition } from "./agent-definition.ts";
import { NATIVE_TOOL_NAMES, type NativeToolName } from "./executor/native-tools.ts";

export type AgentBuiltinToolKind =
	| "send_message"
	| "create_agent"
	| "destroy_agent"
	| "team"
	| "dispatch_bash"
	| "dispatch_read"
	| "dispatch_ls"
	| "dispatch_grep"
	| "dispatch_find"
	| "dispatch_write"
	| "dispatch_edit"
	| "reload";

const AGENT_BUILTIN_TOOL_KIND = Symbol.for("@sheason/d-pi.agentBuiltinToolKind");
export { NATIVE_TOOL_NAMES as DISPATCH_NATIVE_TOOL_NAMES };
export type DispatchNativeToolName = NativeToolName;

type BuiltinMarkedTool = AgentToolDefinition & { [AGENT_BUILTIN_TOOL_KIND]?: AgentBuiltinToolKind };

export function getAgentBuiltinToolKind(tool: AgentToolDefinition): AgentBuiltinToolKind | undefined {
	return (tool as BuiltinMarkedTool)[AGENT_BUILTIN_TOOL_KIND];
}

function builtinStubExecute(): never {
	throw new Error("Built-in tool is not bound to a d-pi worker runtime");
}

function markBuiltinTool(
	name: string,
	label: string,
	description: string,
	parameters: AgentToolDefinition["parameters"],
	kind: AgentBuiltinToolKind,
): AgentToolDefinition {
	const definition: AgentToolDefinition = {
		name,
		label,
		description,
		parameters,
		execute: builtinStubExecute,
	};
	Object.defineProperty(definition, AGENT_BUILTIN_TOOL_KIND, {
		value: kind,
		enumerable: false,
	});
	return definition;
}

const ConnectIdParam = Type.Optional(
	Type.String({
		description: "Optional. The connect_id of the d-pi client to dispatch to. Omit to run locally on the hub host.",
	}),
);

const BashParams = Type.Object({
	command: Type.String(),
	timeout_ms: Type.Optional(Type.Number()),
	connect_id: ConnectIdParam,
});

const PathParams = Type.Object({
	path: Type.Optional(Type.String()),
	connect_id: ConnectIdParam,
});

const ReadParams = Type.Object({
	path: Type.String(),
	connect_id: ConnectIdParam,
});

const GrepParams = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	connect_id: ConnectIdParam,
});

const FindParams = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	connect_id: ConnectIdParam,
});

const WriteParams = Type.Object({
	path: Type.String(),
	content: Type.String(),
	connect_id: ConnectIdParam,
});

const EditParams = Type.Object({
	path: Type.String(),
	old_string: Type.String(),
	new_string: Type.String(),
	connect_id: ConnectIdParam,
});

const DISPATCH_TOOL_DEFS: Record<
	DispatchNativeToolName,
	{ label: string; description: string; parameters: AgentToolDefinition["parameters"] }
> = {
	bash: {
		label: "Dispatch bash",
		description: "Run a shell command locally or on a connected client.",
		parameters: BashParams,
	},
	read: {
		label: "Dispatch read",
		description: "Read a UTF-8 text file locally or on a connected client.",
		parameters: ReadParams,
	},
	ls: {
		label: "Dispatch ls",
		description: "List files in a directory locally or on a connected client.",
		parameters: PathParams,
	},
	grep: {
		label: "Dispatch grep",
		description: "Search text files for a regular expression locally or on a connected client.",
		parameters: GrepParams,
	},
	find: {
		label: "Dispatch find",
		description: "List files whose relative path contains a pattern locally or on a connected client.",
		parameters: FindParams,
	},
	write: {
		label: "Dispatch write",
		description: "Write a UTF-8 text file locally or on a connected client, creating parent directories.",
		parameters: WriteParams,
	},
	edit: {
		label: "Dispatch edit",
		description: "Replace one exact string occurrence in a file locally or on a connected client.",
		parameters: EditParams,
	},
};

export function createSendMessageTool(): AgentToolDefinition {
	return markBuiltinTool(
		"send_message",
		"Send Message",
		"Send a message to another agent in the network. The target agent will receive the message as input. This is asynchronous - the tool returns immediately and does not wait for a reply. Use mode='steer' to interrupt the target's current turn; the default mode='next' queues the message at the start of the target's next turn.",
		Type.Object({
			agent_name: Type.String({ description: "Name of the target agent" }),
			message: Type.String({ description: "Message content to send" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("next"), Type.Literal("steer")], {
					description:
						"Routing mode. 'next' (default) queues at the start of the target's next turn; 'steer' interrupts the current turn.",
				}),
			),
		}),
		"send_message",
	);
}

export function createCreateAgentTool(): AgentToolDefinition {
	return markBuiltinTool(
		"create_agent",
		"Create Agent",
		"Create a new child agent in the network. The new agent will be a direct child of this agent (the caller) and will have its own independent session.",
		Type.Object({
			name: Type.String({ description: "Human-readable name for the new agent" }),
			cwd: Type.Optional(
				Type.String({ description: "Working directory override (defaults to workspace/agents/<name>/)" }),
			),
		}),
		"create_agent",
	);
}

export function createDestroyAgentTool(): AgentToolDefinition {
	return markBuiltinTool(
		"destroy_agent",
		"Destroy Agent",
		"Destroy an agent in the network. The agent must have no children and must not be the creator of any active source.",
		Type.Object({
			agent_name: Type.String({ description: "Name of the agent to destroy" }),
		}),
		"destroy_agent",
	);
}

export function createTeamTool(): AgentToolDefinition {
	return markBuiltinTool(
		"team",
		"Team",
		"List the current team snapshot - agents, their parent/child relationships, roles, and connection status. Use agent names when calling destroy_agent or send_message.",
		Type.Object({}),
		"team",
	);
}

export function createDispatchBashTool(): AgentToolDefinition {
	return createDispatchToolStub("bash");
}

export function createDispatchReadTool(): AgentToolDefinition {
	return createDispatchToolStub("read");
}

export function createDispatchLsTool(): AgentToolDefinition {
	return createDispatchToolStub("ls");
}

export function createDispatchGrepTool(): AgentToolDefinition {
	return createDispatchToolStub("grep");
}

export function createDispatchFindTool(): AgentToolDefinition {
	return createDispatchToolStub("find");
}

export function createDispatchWriteTool(): AgentToolDefinition {
	return createDispatchToolStub("write");
}

export function createDispatchEditTool(): AgentToolDefinition {
	return createDispatchToolStub("edit");
}

export function createDispatchTools(): AgentToolDefinition[] {
	return NATIVE_TOOL_NAMES.map(createDispatchToolStub);
}

export function createReloadTool(): AgentToolDefinition {
	return markBuiltinTool(
		"reload",
		"Reload Workspace",
		"Reload the d-pi workspace configuration and notify every agent to reload its own resources. Ready agents reload immediately; busy agents reload when they become ready.",
		Type.Object({
			reason: Type.Optional(
				Type.String({
					description: "Optional reason for the workspace reload. Explain what changed or why reload is needed.",
				}),
			),
		}),
		"reload",
	);
}

function createDispatchToolStub(nativeName: DispatchNativeToolName): AgentToolDefinition {
	const def = DISPATCH_TOOL_DEFS[nativeName];
	return markBuiltinTool(
		`dispatch_${nativeName}`,
		def.label,
		def.description,
		def.parameters,
		`dispatch_${nativeName}` as AgentBuiltinToolKind,
	);
}
