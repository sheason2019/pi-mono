import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const inheritedResourceSelectionSchema = Type.Union([
	Type.Literal(true, { description: "Inherit every host resource of this type." }),
	Type.Array(Type.String({ minLength: 1 }), {
		description: "Names of host resources to inherit. Names are matched before hub namespacing.",
	}),
]);

const childExtendsSchema = Type.Object(
	{
		mcp: Type.Optional(inheritedResourceSelectionSchema),
		sources: Type.Optional(inheritedResourceSelectionSchema),
	},
	{
		additionalProperties: false,
		description: "Only valid for child agents. Explicitly inherit selected stateful resources from the host agent.",
	},
);

const hubExecutorSchema = Type.Union([Type.Literal("enabled"), Type.Literal("disabled")], {
	description: 'Whether this child may use the hub host executor via peer-id "host".',
});

const nodeContainerExecutorSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "Stable executor config id." }),
		type: Type.Literal("node-container"),
		peerId: Type.String({ minLength: 1, description: "Peer id used by the containerized d-pi peer." }),
		image: Type.Optional(Type.String({ minLength: 1, description: "Docker image. Defaults to node:22." })),
		command: Type.Array(Type.String(), {
			minItems: 1,
			description: 'Command executed inside the container, for example ["npx", "d-pi", "peer"].',
		}),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		workdir: Type.Optional(Type.String({ minLength: 1 })),
		containerName: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const createChildSchema = Type.Object(
	{
		mode: Type.Union([Type.Literal("spawn"), Type.Literal("fork")], {
			description: '"spawn" starts a blank child session; "fork" branches from the current agent session.',
		}),
		name: Type.Optional(Type.String({ description: "Display name for the child agent." })),
		description: Type.Optional(Type.String({ description: "Short description of the child." })),
		background: Type.Optional(
			Type.String({
				minLength: 1,
				description: 'Required when mode="spawn". Stored as a visible user message in the new child session.',
			}),
		),
		instructions: Type.Optional(Type.String({ description: 'Optional user message appended when mode="fork".' })),
		extends: Type.Optional(childExtendsSchema),
		hubExecutor: Type.Optional(hubExecutorSchema),
		executors: Type.Optional(Type.Array(nodeContainerExecutorSchema)),
		temporary: Type.Optional(
			Type.Boolean({
				description:
					"When true, create a temporary child that runs the requested task once, optionally reports back, then is removed after it becomes idle.",
			}),
		),
		reportResult: Type.Optional(
			Type.Boolean({
				description:
					"For temporary children only. Defaults to true; when false, skip reporting the final assistant text back to the parent before deletion.",
			}),
		),
	},
	{ additionalProperties: false },
);

const createTemporaryChildSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ description: "Display name for the temporary child agent." })),
		description: Type.Optional(Type.String({ description: "Short description of the temporary child task." })),
		background: Type.String({
			minLength: 1,
			description: "Task/background message for the temporary child. It is stored as the initial user message.",
		}),
		extends: Type.Optional(childExtendsSchema),
		reportResult: Type.Optional(
			Type.Boolean({
				description:
					"Defaults to true; when false, skip reporting the final assistant text back to the parent before deletion.",
			}),
		),
	},
	{ additionalProperties: false },
);

const childLifecycleSchema = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Target child agent id." }),
	},
	{ additionalProperties: false },
);

const updateChildSchema = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Target child agent id." }),
		name: Type.Optional(Type.String({ description: "Updated display name for the child agent." })),
		description: Type.Optional(Type.String({ description: "Updated short description of the child agent." })),
		hubExecutor: Type.Optional(hubExecutorSchema),
		executors: Type.Optional(Type.Array(nodeContainerExecutorSchema)),
	},
	{ additionalProperties: false },
);

const renameChildSchema = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Current child agent id." }),
		newAgentId: Type.String({
			minLength: 1,
			description: "New child agent id. It is normalized with the same id rules used when creating child agents.",
		}),
	},
	{ additionalProperties: false },
);

const removeChildSchema = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Target child agent id." }),
		deleteFiles: Type.Optional(
			Type.Boolean({
				description:
					"When true, delete the child agent directory after removing the registry entry. Defaults to false.",
			}),
		),
	},
	{ additionalProperties: false },
);

const searchMemorySchema = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Search query for historical session memory." }),
		agentId: Type.Optional(Type.String({ minLength: 1, description: "Optional target agent id to search." })),
		limit: Type.Optional(
			Type.Number({
				minimum: 1,
				maximum: 100,
				description: "Max number of memory hits to return.",
			}),
		),
		includeToolResults: Type.Optional(
			Type.Boolean({
				description: "When false, omits tool-result messages and assistant tool-call messages.",
			}),
		),
	},
	{ additionalProperties: false },
);

const listMemorySchema = Type.Object(
	{
		memoryIds: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			description: "Memory ids returned by search_memory.",
		}),
		contextBefore: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 20,
				description: "Number of memory entries to include before each hit in the same session.",
			}),
		),
		contextAfter: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 20,
				description: "Number of memory entries to include after each hit in the same session.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ChildResourceExtends = Static<typeof childExtendsSchema> | undefined;
export type SpawnChildToolInput = {
	name?: string;
	description?: string;
	background: string;
	extends?: ChildResourceExtends;
	temporary?: boolean;
	reportResult?: boolean;
	hubExecutor?: "enabled" | "disabled";
	executors?: Static<typeof nodeContainerExecutorSchema>[];
};
export type ForkChildToolInput = {
	name?: string;
	description?: string;
	instructions?: string;
	extends?: ChildResourceExtends;
	hubExecutor?: "enabled" | "disabled";
	executors?: Static<typeof nodeContainerExecutorSchema>[];
};
export type CreateChildToolInput = Static<typeof createChildSchema>;
export type CreateTemporaryChildToolInput = Static<typeof createTemporaryChildSchema>;
export type UpdateChildToolInput = Static<typeof updateChildSchema>;
export type RenameChildToolInput = Static<typeof renameChildSchema>;
export type StopChildToolInput = Static<typeof childLifecycleSchema>;
export type StartChildToolInput = Static<typeof childLifecycleSchema>;
export type RemoveChildToolInput = Static<typeof removeChildSchema>;
export type SearchMemoryToolInput = Static<typeof searchMemorySchema>;
export type ListMemoryToolInput = Static<typeof listMemorySchema>;

/**
 * Host surface (implemented by `HubRuntime`) for main-only child management tools. Kept as an interface to avoid
 * circular runtime imports in tool executors.
 */
export interface ChildAgentToolHost {
	createChildAgent(callerAgentId: string, input: CreateChildToolInput): Promise<string>;
	createTemporaryChildAgent(callerAgentId: string, input: CreateTemporaryChildToolInput): Promise<string>;
	updateChildAgent(callerAgentId: string, input: UpdateChildToolInput): Promise<string>;
	renameChildAgent(callerAgentId: string, input: RenameChildToolInput): Promise<string>;
	stopChildAgent(callerAgentId: string, input: StopChildToolInput): Promise<string>;
	startChildAgent(callerAgentId: string, input: StartChildToolInput): Promise<string>;
	removeChildAgent(callerAgentId: string, input: RemoveChildToolInput): Promise<string>;
	searchMemoryText(callerAgentId: string, input: SearchMemoryToolInput): Promise<string>;
	listMemoryText(callerAgentId: string, input: ListMemoryToolInput): Promise<string>;
}

export function createChildAgentToolDefinitions(
	getHost: () => ChildAgentToolHost,
	callerAgentId: string,
): ToolDefinition[] {
	return [
		defineTool({
			name: "create_child_agent",
			label: "create_child_agent",
			description:
				"Create and start a direct child agent below the current agent. Use mode=spawn for a blank session with background, or mode=fork to branch from the current session.",
			parameters: createChildSchema,
			async execute(_id, params) {
				const text = await getHost().createChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "create_temporary_child_agent",
			label: "create_temporary_child_agent",
			description:
				"Create a temporary direct child agent for one task. It runs independently, becomes idle, optionally reports its final result, then the hub deletes it automatically.",
			parameters: createTemporaryChildSchema,
			async execute(_id, params) {
				const text = await getHost().createTemporaryChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "update_child_agent",
			label: "update_child_agent",
			description:
				"Update child agent metadata and parent-controlled executor policy. Direct parents may change hubExecutor at runtime; children cannot re-enable parent-disabled executors.",
			parameters: updateChildSchema,
			async execute(_id, params) {
				const text = await getHost().updateChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "rename_child_agent",
			label: "rename_child_agent",
			description:
				"Rename a stopped direct child agent id. The direct parent must call this, the target child must be stopped, and descendant parent links are migrated.",
			parameters: renameChildSchema,
			async execute(_id, params) {
				const text = await getHost().renameChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "stop_child_agent",
			label: "stop_child_agent",
			description:
				"Stop a running child agent like `docker stop`: disconnect its peers and stop its runtime, while keeping its registry entry and .child-agent files so it can be started again.",
			parameters: childLifecycleSchema,
			async execute(_id, params) {
				const text = await getHost().stopChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "start_child_agent",
			label: "start_child_agent",
			description:
				"Start a stopped child agent like `docker start`: create and start a runtime for an existing child registry entry.",
			parameters: childLifecycleSchema,
			async execute(_id, params) {
				const text = await getHost().startChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "remove_child_agent",
			label: "remove_child_agent",
			description:
				"Remove a child agent like `docker rm`: stop it if needed, remove it from the registry, and optionally delete its .child-agent files with deleteFiles=true.",
			parameters: removeChildSchema,
			async execute(_id, params) {
				const text = await getHost().removeChildAgent(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "search_memory",
			label: "search_memory",
			description:
				"Search long-term indexed session memory for the current agent subtree. Returns compact hits and memoryId values.",
			parameters: searchMemorySchema,
			async execute(_id, params) {
				const text = await getHost().searchMemoryText(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
		defineTool({
			name: "list_memory",
			label: "list_memory",
			description:
				"Expand memoryId values from search_memory into nearby session context with timestamps, agent, role, model, and text.",
			parameters: listMemorySchema,
			async execute(_id, params) {
				const text = await getHost().listMemoryText(callerAgentId, params);
				return { content: [{ type: "text" as const, text }], details: null };
			},
		}),
	];
}
