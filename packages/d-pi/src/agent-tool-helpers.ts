import type { AgentToolDefinition } from "./agent-definition.ts";
import { buildNativeToolSet } from "./executor/native-tools.ts";
import type { ToolDefinition } from "./extension/contracts.ts";
import {
	createDPiCreateAgentTool,
	createDPiDeleteSourceTool,
	createDPiDestroyAgentTool,
	createDPiDispatchTools,
	createDPiGetSourceTool,
	createDPiReloadTool,
	createDPiSendMessageTool,
	createDPiSetSourceTool,
	createDPiTeamTool,
	type DPiDispatchLocalExecutors,
	type DPiDispatchNativeToolName,
	type DPiDispatchParameterSchemas,
	type DPiHubActionsClient,
} from "./surface/index.ts";

export type AgentBuiltinToolKind =
	| "send_message"
	| "create_agent"
	| "destroy_agent"
	| "team"
	| "set_source"
	| "get_source"
	| "delete_source"
	| "dispatch_bash"
	| "dispatch_read"
	| "dispatch_ls"
	| "dispatch_grep"
	| "dispatch_find"
	| "dispatch_write"
	| "dispatch_edit"
	| "reload";

const AGENT_BUILTIN_TOOL_KIND = Symbol.for("@sheason/d-pi.agentBuiltinToolKind");
const DISPATCH_NATIVE_TOOL_NAMES = ["bash", "read", "ls", "grep", "find", "write", "edit"] as const;

type BuiltinMarkedTool = AgentToolDefinition & { [AGENT_BUILTIN_TOOL_KIND]?: AgentBuiltinToolKind };

export function getAgentBuiltinToolKind(tool: AgentToolDefinition): AgentBuiltinToolKind | undefined {
	return (tool as BuiltinMarkedTool)[AGENT_BUILTIN_TOOL_KIND];
}

export function createSendMessageTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiSendMessageTool(fakeHubClient, { agentName: "agent" }), "send_message");
}

export function createCreateAgentTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiCreateAgentTool(fakeHubClient), "create_agent");
}

export function createDestroyAgentTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiDestroyAgentTool(fakeHubClient), "destroy_agent");
}

export function createTeamTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiTeamTool(fakeHubClient), "team");
}

export function createSetSourceTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiSetSourceTool(fakeHubClient), "set_source");
}

export function createGetSourceTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiGetSourceTool(fakeHubClient), "get_source");
}

export function createDeleteSourceTool(): AgentToolDefinition {
	return markBuiltinTool(createDPiDeleteSourceTool(fakeHubClient), "delete_source");
}

export function createDispatchBashTool(): AgentToolDefinition {
	return createDispatchTool("bash");
}

export function createDispatchReadTool(): AgentToolDefinition {
	return createDispatchTool("read");
}

export function createDispatchLsTool(): AgentToolDefinition {
	return createDispatchTool("ls");
}

export function createDispatchGrepTool(): AgentToolDefinition {
	return createDispatchTool("grep");
}

export function createDispatchFindTool(): AgentToolDefinition {
	return createDispatchTool("find");
}

export function createDispatchWriteTool(): AgentToolDefinition {
	return createDispatchTool("write");
}

export function createDispatchEditTool(): AgentToolDefinition {
	return createDispatchTool("edit");
}

export function createDispatchTools(): AgentToolDefinition[] {
	return DISPATCH_NATIVE_TOOL_NAMES.map(createDispatchTool);
}

export function createReloadTool(): AgentToolDefinition {
	return markBuiltinTool(
		createDPiReloadTool({
			runtimeHooks: {
				reloadContext: async () => {
					throw new Error("reload is not bound to a d-pi worker runtime");
				},
			},
			getSnapshot: () => {
				throw new Error("reload is not bound to a d-pi worker runtime");
			},
		}),
		"reload",
	);
}

function createDispatchTool(nativeName: DPiDispatchNativeToolName): AgentToolDefinition {
	const tool = createDispatchToolDescriptors().find((candidate) => candidate.name === `dispatch_${nativeName}`);
	if (!tool) {
		throw new Error(`Missing d-pi dispatch tool descriptor for ${nativeName}`);
	}
	return markBuiltinTool(tool, `dispatch_${nativeName}` as AgentBuiltinToolKind);
}

function createDispatchToolDescriptors(): AgentToolDefinition[] {
	const nativeTools = new Map(buildNativeToolSet(".").map((tool) => [tool.name, tool]));
	const localExecutors = {} as DPiDispatchLocalExecutors;
	const parameterSchemas = {} as DPiDispatchParameterSchemas;
	for (const nativeName of DISPATCH_NATIVE_TOOL_NAMES) {
		const nativeTool = nativeTools.get(nativeName);
		if (!nativeTool) {
			throw new Error(`Missing d-pi native tool: ${nativeName}`);
		}
		parameterSchemas[nativeName] = nativeTool.parameters;
		localExecutors[nativeName] = async () => {
			throw new Error(`dispatch_${nativeName} is not bound to a d-pi worker runtime`);
		};
	}
	return createDPiDispatchTools({
		localExecutors,
		parameterSchemas,
		remoteExecutor: {
			async executeRemoteTool() {
				throw new Error("dispatch tools are not bound to a d-pi worker runtime");
			},
		},
	}).map((tool) => tool as AgentToolDefinition);
}

function markBuiltinTool(tool: ToolDefinition, kind: AgentBuiltinToolKind): AgentToolDefinition {
	const definition = {
		...tool,
		label: tool.label ?? tool.name,
		async execute() {
			throw new Error(`${kind} is not bound to a d-pi worker runtime`);
		},
	} as AgentToolDefinition;
	Object.defineProperty(definition, AGENT_BUILTIN_TOOL_KIND, {
		value: kind,
		enumerable: false,
	});
	return definition;
}

const fakeHubClient: DPiHubActionsClient = {
	async createAgent() {
		throw new Error("create_agent is not bound to a d-pi worker runtime");
	},
	async destroyAgent() {
		throw new Error("destroy_agent is not bound to a d-pi worker runtime");
	},
	async getTeam() {
		throw new Error("team is not bound to a d-pi worker runtime");
	},
	async sendMessage() {
		throw new Error("send_message is not bound to a d-pi worker runtime");
	},
	async setSource() {
		throw new Error("set_source is not bound to a d-pi worker runtime");
	},
	async getSource() {
		throw new Error("get_source is not bound to a d-pi worker runtime");
	},
	async deleteSource() {
		throw new Error("delete_source is not bound to a d-pi worker runtime");
	},
	async dispatchRemoteTool() {
		throw new Error("dispatch tools are not bound to a d-pi worker runtime");
	},
};
