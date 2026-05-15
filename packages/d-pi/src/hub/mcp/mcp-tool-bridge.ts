import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
	CallToolResult,
	GetPromptResult,
	Prompt,
	ReadResourceResult,
	Resource,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@sheason/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@sheason/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { jsonSchemaToTypebox } from "./json-schema-to-typebox.js";
import type { McpClientHandle } from "./mcp-client.js";
import type { McpToolSummary } from "./types.js";

const MAX_MCP_FULL_TOOL_NAME = 64;
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Matches `AgentToolResult["content"]` items from pi-agent-core. */
type AgentContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const SYNTHETIC_LIST_RESOURCES = "list_resources";
const SYNTHETIC_READ_RESOURCE = "read_resource";
const SYNTHETIC_LIST_PROMPTS = "list_prompts";
const SYNTHETIC_GET_PROMPT = "get_prompt";

export function buildMcpPrefixedToolName(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`;
}

function isUsableMcpToolName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_MCP_FULL_TOOL_NAME && NAME_PATTERN.test(name);
}

function textBlock(text: string): AgentContentBlock {
	return { type: "text", text };
}

function mcpTextFromContent(result: CallToolResult): string {
	const parts: string[] = [];
	for (const c of result.content) {
		if (c.type === "text" && "text" in c) {
			parts.push(c.text);
		}
	}
	if (result.structuredContent && typeof result.structuredContent === "object") {
		try {
			parts.push(JSON.stringify(result.structuredContent));
		} catch {
			// ignore
		}
	}
	return parts.join("\n") || "MCP tool reported an error";
}

/**
 * Map MCP `CallToolResult` blocks to the agent's content block model.
 * Non-text/image blocks are coerced to text for LLM safety.
 */
export function mapCallToolResultToAgentContent(result: CallToolResult): AgentContentBlock[] {
	const out: AgentContentBlock[] = [];
	for (const c of result.content) {
		if (c.type === "text" && "text" in c) {
			out.push({ type: "text", text: c.text });
			continue;
		}
		if (c.type === "image" && "data" in c && "mimeType" in c) {
			out.push({ type: "image", data: c.data, mimeType: c.mimeType });
			continue;
		}
		if (c.type === "resource" && "resource" in c) {
			const r = c.resource;
			if ("text" in r && typeof (r as { text?: string }).text === "string") {
				out.push({ type: "text", text: (r as { text: string }).text });
			} else {
				try {
					out.push({ type: "text", text: JSON.stringify(r) });
				} catch {
					out.push({ type: "text", text: "[resource payload]" });
				}
			}
			continue;
		}
		if (c.type === "resource_link" && "name" in c) {
			const uri = (c as { uri: string; name: string; mimeType?: string }).uri;
			const name = (c as { name: string }).name;
			const mime = (c as { mimeType?: string }).mimeType;
			out.push({ type: "text", text: `resource_link: ${name} <${uri}>${mime ? ` (${mime})` : ""}` });
			continue;
		}
		if (c.type === "audio" && "data" in c) {
			out.push({ type: "text", text: `[audio ${(c as { mimeType: string }).mimeType}]` });
			continue;
		}
		try {
			out.push({ type: "text", text: JSON.stringify(c) });
		} catch {
			out.push({ type: "text", text: "[mcp content]" });
		}
	}
	return out.length > 0 ? out : [textBlock("")];
}

export type WrapMcpToolOutcome =
	| (ToolDefinition & { name: string })
	| { skipped: true; reason: string; toolName: string };

export function wrapMcpToolAsToolDefinition(
	serverName: string,
	client: Client,
	tool: McpToolSummary,
): WrapMcpToolOutcome {
	const fullName = buildMcpPrefixedToolName(serverName, tool.name);
	if (!isUsableMcpToolName(fullName)) {
		return {
			skipped: true,
			toolName: tool.name,
			reason: `Prefixed name must match ${NAME_PATTERN.source}, length <= ${MAX_MCP_FULL_TOOL_NAME}`,
		};
	}

	const paramsSchema: TSchema =
		tool.inputSchema === undefined ? Type.Object({}) : jsonSchemaToTypebox(tool.inputSchema);

	return defineTool({
		name: fullName,
		label: tool.name,
		description: tool.description ?? `MCP tool ${tool.name} on server ${serverName}`,
		parameters: paramsSchema,
		async execute(
			_toolCallId: string,
			params: Static<typeof paramsSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			try {
				const result = (await client.callTool(
					{ name: tool.name, arguments: (params as Record<string, unknown>) ?? {} },
					undefined,
					{ signal },
				)) as CallToolResult;
				if (result.isError) {
					throw new Error(mcpTextFromContent(result));
				}
				return {
					content: mapCallToolResultToAgentContent(result),
					details: {
						structuredContent: result.structuredContent,
					},
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(msg);
			}
		},
	});
}

export type McpServerBridgeSkipEntry = { kind: "tool" | "resource" | "prompt"; name: string; reason: string };

async function listAllResources(client: Client, signal?: AbortSignal): Promise<Resource[]> {
	const out: Resource[] = [];
	let cursor: string | undefined;
	for (;;) {
		const res = await client.listResources(cursor ? { cursor } : {}, { signal });
		for (const r of res.resources) {
			out.push(r);
		}
		if (!res.nextCursor) {
			break;
		}
		cursor = res.nextCursor;
	}
	return out;
}

async function listAllPrompts(client: Client, signal?: AbortSignal): Promise<Prompt[]> {
	const out: Prompt[] = [];
	let cursor: string | undefined;
	for (;;) {
		const res = await client.listPrompts(cursor ? { cursor } : {}, { signal });
		for (const p of res.prompts) {
			out.push(p);
		}
		if (!res.nextCursor) {
			break;
		}
		cursor = res.nextCursor;
	}
	return out;
}

const listResourcesEmptySchema = Type.Object({});

const readResourceParamSchema = Type.Object({
	uri: Type.String({ description: "Resource URI to read" }),
});

const listPromptsEmptySchema = Type.Object({});

const getPromptParamSchema = Type.Object({
	name: Type.String({ description: "Prompt name from list_prompts" }),
	arguments: Type.Optional(
		Type.Unsafe<Record<string, string>>({ type: "object", additionalProperties: { type: "string" } }),
	),
});

/**
 * Synthesize the hub `list_resources` / `read_resource` / `list_prompts` / `get_prompt` tools
 * and merge them with server-declared tools.
 */
export function wrapMcpServerAsToolDefinitions(
	serverName: string,
	handle: McpClientHandle,
): { tools: ToolDefinition[]; skipped: McpServerBridgeSkipEntry[] } {
	const client = handle.client;
	const usedNames = new Set<string>();
	const tools: ToolDefinition[] = [];
	const skipped: McpServerBridgeSkipEntry[] = [];

	const register = (def: ToolDefinition) => {
		usedNames.add(def.name);
		tools.push(def);
	};

	const tryAddSyn = (syntheticName: string, kind: "resource" | "prompt", build: () => ToolDefinition) => {
		const full = buildMcpPrefixedToolName(serverName, syntheticName);
		if (usedNames.has(full)) {
			skipped.push({
				kind,
				name: syntheticName,
				reason: "Prefixed name already used by another tool for this server",
			});
			return;
		}
		if (!isUsableMcpToolName(full)) {
			skipped.push({
				kind,
				name: syntheticName,
				reason: "Synthetic prefixed name is invalid or too long",
			});
			return;
		}
		register(build());
	};

	if (handle.supportedCapabilities.tools) {
		for (const t of handle.capabilities.tools) {
			const w = wrapMcpToolAsToolDefinition(serverName, client, t);
			if ("skipped" in w) {
				skipped.push({ kind: "tool", name: t.name, reason: w.reason });
				continue;
			}
			if (usedNames.has(w.name)) {
				skipped.push({
					kind: "tool",
					name: t.name,
					reason: "Prefixed name already used (duplicate tool name?)",
				});
				continue;
			}
			register(w);
		}
	}

	if (handle.supportedCapabilities.resources) {
		tryAddSyn(SYNTHETIC_LIST_RESOURCES, "resource", () =>
			defineTool({
				name: buildMcpPrefixedToolName(serverName, SYNTHETIC_LIST_RESOURCES),
				label: SYNTHETIC_LIST_RESOURCES,
				description: `List resource URIs and metadata for MCP server "${serverName}"`,
				parameters: listResourcesEmptySchema,
				async execute(
					_t: string,
					_p: Record<string, never>,
					signal: AbortSignal | undefined,
					_on: AgentToolUpdateCallback<unknown> | undefined,
					_ctx: ExtensionContext,
				): Promise<AgentToolResult<{ resources: Resource[] }>> {
					const resources = await listAllResources(client, signal);
					return {
						content: [{ type: "text", text: JSON.stringify(resources, null, 2) }],
						details: { resources },
					};
				},
			}),
		);

		tryAddSyn(SYNTHETIC_READ_RESOURCE, "resource", () =>
			defineTool({
				name: buildMcpPrefixedToolName(serverName, SYNTHETIC_READ_RESOURCE),
				label: SYNTHETIC_READ_RESOURCE,
				description: `Read a resource by URI for MCP server "${serverName}"`,
				parameters: readResourceParamSchema,
				async execute(
					_t: string,
					params: Static<typeof readResourceParamSchema>,
					signal: AbortSignal | undefined,
					_on: AgentToolUpdateCallback<unknown> | undefined,
					_ctx: ExtensionContext,
				): Promise<AgentToolResult<{ contents: ReadResourceResult["contents"] }>> {
					try {
						const r = await client.readResource({ uri: params.uri }, { signal });
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(r.contents, null, 2),
								},
							],
							details: { contents: r.contents },
						};
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(msg);
					}
				},
			}),
		);
	} else {
		skipped.push({
			kind: "resource",
			name: SYNTHETIC_LIST_RESOURCES,
			reason: "Server does not implement resources (method not found)",
		});
		skipped.push({
			kind: "resource",
			name: SYNTHETIC_READ_RESOURCE,
			reason: "Server does not implement resources (method not found)",
		});
	}

	if (handle.supportedCapabilities.prompts) {
		tryAddSyn(SYNTHETIC_LIST_PROMPTS, "prompt", () =>
			defineTool({
				name: buildMcpPrefixedToolName(serverName, SYNTHETIC_LIST_PROMPTS),
				label: SYNTHETIC_LIST_PROMPTS,
				description: `List available prompts for MCP server "${serverName}"`,
				parameters: listPromptsEmptySchema,
				async execute(
					_t: string,
					_p: Record<string, never>,
					signal: AbortSignal | undefined,
					_on: AgentToolUpdateCallback<unknown> | undefined,
					_ctx: ExtensionContext,
				): Promise<AgentToolResult<{ prompts: Prompt[] }>> {
					const prompts = await listAllPrompts(client, signal);
					return {
						content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
						details: { prompts },
					};
				},
			}),
		);

		tryAddSyn(SYNTHETIC_GET_PROMPT, "prompt", () =>
			defineTool({
				name: buildMcpPrefixedToolName(serverName, SYNTHETIC_GET_PROMPT),
				label: SYNTHETIC_GET_PROMPT,
				description: `Load prompt messages for MCP server "${serverName}"`,
				parameters: getPromptParamSchema,
				async execute(
					_t: string,
					params: Static<typeof getPromptParamSchema>,
					signal: AbortSignal | undefined,
					_on: AgentToolUpdateCallback<unknown> | undefined,
					_ctx: ExtensionContext,
				): Promise<AgentToolResult<{ messages: GetPromptResult["messages"] }>> {
					try {
						const r: GetPromptResult = await client.getPrompt(
							{ name: params.name, arguments: params.arguments },
							{ signal },
						);
						return {
							content: [{ type: "text", text: JSON.stringify(r.messages, null, 2) }],
							details: { messages: r.messages },
						};
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(msg);
					}
				},
			}),
		);
	} else {
		skipped.push({
			kind: "prompt",
			name: SYNTHETIC_LIST_PROMPTS,
			reason: "Server does not implement prompts (method not found)",
		});
		skipped.push({
			kind: "prompt",
			name: SYNTHETIC_GET_PROMPT,
			reason: "Server does not implement prompts (method not found)",
		});
	}

	return { tools, skipped };
}
