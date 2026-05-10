export type McpTransport = "stdio" | "http";

export type McpRuntimeStatusKind = "starting" | "running" | "stopped" | "error";

export interface McpServerConfigBase {
	resourceId?: string;
	name: string;
	transport: McpTransport;
	disabled?: boolean;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	transport: "stdio";
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	transport: "http";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Per-method availability from MCP discovery (false when the server returns method not found). */
export interface McpSupportedCapabilities {
	tools: boolean;
	resources: boolean;
	prompts: boolean;
}

export interface McpToolSummary {
	name: string;
	description?: string;
	/** Raw `inputSchema` from `tools/list` for JSON Schema → TypeBox bridging. */
	inputSchema?: unknown;
}

export interface McpRuntimeStatus {
	resourceId?: string;
	name: string;
	transport: McpTransport;
	status: McpRuntimeStatusKind;
	disabled?: boolean;
	error?: string;
	capabilities: McpCapabilitySummary;
}

export interface McpCapabilitySummary {
	tools: McpToolSummary[];
	resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
	prompts: Array<{ name: string; description?: string }>;
}
