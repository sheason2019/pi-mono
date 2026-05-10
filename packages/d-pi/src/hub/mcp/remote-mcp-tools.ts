import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { PeerToolBridge } from "../tools/peer-tool-bridge.js";
import { jsonSchemaToTypebox } from "./json-schema-to-typebox.js";
import type { McpRuntimeStatus, McpToolSummary } from "./types.js";

const MAX_SOURCE_TOKEN_LENGTH = 24;

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

export function safeResourceToken(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	if (safe.length === 0) {
		return `x_${shortHash(value)}`;
	}
	if (safe === value && safe.length <= MAX_SOURCE_TOKEN_LENGTH) {
		return safe;
	}
	return `${safe.slice(0, MAX_SOURCE_TOKEN_LENGTH)}_${shortHash(value)}`;
}

function remoteMcpResourceKey(peerId: string, resourceId: string): string {
	return `${peerId}:${resourceId}`;
}

export function remoteMcpResourceToken(peerId: string, resourceId: string): string {
	return safeResourceToken(remoteMcpResourceKey(peerId, resourceId));
}

function buildRemoteMcpToolName(peerId: string, server: McpRuntimeStatus, toolName: string): string {
	const resourceId = server.resourceId ?? server.name;
	return `mcp__${remoteMcpResourceToken(peerId, resourceId)}__${toolName}`;
}

export function remoteMcpToolNameFromLocal(peerId: string, localMcpToolName: string): string | undefined {
	const match = /^mcp__([^_][^_]*)__([^_][\s\S]*)$/.exec(localMcpToolName);
	if (!match) {
		return undefined;
	}
	return `mcp__${remoteMcpResourceToken(peerId, match[1]!)}__${match[2]!}`;
}

function parametersFromTool(tool: McpToolSummary): TSchema {
	if (!tool.inputSchema) {
		return Type.Object({});
	}
	try {
		return jsonSchemaToTypebox(tool.inputSchema);
	} catch {
		return Type.Object({});
	}
}

export function createRemoteMcpToolDefinitions(options: {
	peerId: string;
	servers: McpRuntimeStatus[];
	bridge: PeerToolBridge;
}): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	for (const server of options.servers) {
		if (server.status !== "running") {
			continue;
		}
		for (const tool of server.capabilities.tools) {
			const parameters = parametersFromTool(tool);
			const name = buildRemoteMcpToolName(options.peerId, server, tool.name);
			tools.push(
				defineTool({
					name,
					label: `Peer MCP: ${server.name}/${tool.name}`,
					description: `${tool.description ?? `MCP tool ${tool.name}`} This MCP tool runs on peer "${options.peerId}".`,
					parameters,
					async execute(toolCallId, params, signal, onUpdate) {
						return options.bridge.executeTool({
							toolCallId,
							toolName: name,
							peerId: options.peerId,
							args: params as Record<string, unknown>,
							signal,
							onUpdate,
						});
					},
				}),
			);
		}
	}
	return tools;
}
