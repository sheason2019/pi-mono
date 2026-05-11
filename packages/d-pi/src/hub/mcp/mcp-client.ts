import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DetachedStdioClientTransport } from "./detached-stdio-client-transport.js";
import type {
	McpCapabilitySummary,
	McpServerConfig,
	McpSupportedCapabilities,
	McpToolSummary,
	McpTransport,
} from "./types.js";

export class McpClientTimeoutError extends Error {
	readonly name = "McpClientTimeoutError";
	constructor(timeoutMsOrMessage?: number | string) {
		super(formatMcpClientTimeoutMessage(timeoutMsOrMessage));
	}
}

function formatMcpClientTimeoutMessage(timeoutMsOrMessage?: number | string): string {
	if (typeof timeoutMsOrMessage === "string") {
		return timeoutMsOrMessage;
	}
	const suffix = timeoutMsOrMessage === undefined ? "" : ` after ${timeoutMsOrMessage}ms`;
	return `MCP client connection or capability discovery timed out${suffix}`;
}

export interface McpClientHandle {
	client: Client;
	capabilities: McpCapabilitySummary;
	/** When false, the server does not implement that list method (method not found). */
	supportedCapabilities: McpSupportedCapabilities;
	transport: McpTransport;
	close(): Promise<void>;
}

function isMethodNotFound(err: unknown): boolean {
	return err instanceof McpError && err.code === ErrorCode.MethodNotFound;
}

async function listToolsSummary(
	client: Client,
	requestOptions: { signal?: AbortSignal },
): Promise<{ summary: McpToolSummary[]; available: boolean }> {
	try {
		const out: McpToolSummary[] = [];
		let cursor: string | undefined;
		for (;;) {
			const res = await client.listTools(cursor ? { cursor } : {}, { signal: requestOptions.signal });
			for (const t of res.tools) {
				out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
			}
			if (!res.nextCursor) {
				break;
			}
			cursor = res.nextCursor;
		}
		return { summary: out, available: true };
	} catch (e) {
		if (isMethodNotFound(e)) {
			return { summary: [], available: false };
		}
		throw e;
	}
}

async function listResourcesSummary(
	client: Client,
	requestOptions: { signal?: AbortSignal },
): Promise<{ summary: McpCapabilitySummary["resources"]; available: boolean }> {
	try {
		const out: McpCapabilitySummary["resources"] = [];
		let cursor: string | undefined;
		for (;;) {
			const res = await client.listResources(cursor ? { cursor } : {}, { signal: requestOptions.signal });
			for (const r of res.resources) {
				out.push({
					uri: r.uri,
					name: r.name,
					description: r.description,
					mimeType: r.mimeType,
				});
			}
			if (!res.nextCursor) {
				break;
			}
			cursor = res.nextCursor;
		}
		return { summary: out, available: true };
	} catch (e) {
		if (isMethodNotFound(e)) {
			return { summary: [], available: false };
		}
		throw e;
	}
}

async function listPromptsSummary(
	client: Client,
	requestOptions: { signal?: AbortSignal },
): Promise<{ summary: McpCapabilitySummary["prompts"]; available: boolean }> {
	try {
		const out: McpCapabilitySummary["prompts"] = [];
		let cursor: string | undefined;
		for (;;) {
			const res = await client.listPrompts(cursor ? { cursor } : {}, { signal: requestOptions.signal });
			for (const p of res.prompts) {
				out.push({ name: p.name, description: p.description });
			}
			if (!res.nextCursor) {
				break;
			}
			cursor = res.nextCursor;
		}
		return { summary: out, available: true };
	} catch (e) {
		if (isMethodNotFound(e)) {
			return { summary: [], available: false };
		}
		throw e;
	}
}

async function discoverCapabilities(
	client: Client,
	requestOptions: { signal?: AbortSignal },
): Promise<{ capabilities: McpCapabilitySummary; supportedCapabilities: McpSupportedCapabilities }> {
	const serverCapabilities = client.getServerCapabilities();
	const [tools, resources, prompts] = await Promise.all([
		serverCapabilities?.tools
			? listToolsSummary(client, requestOptions)
			: Promise.resolve({ summary: [], available: false }),
		serverCapabilities?.resources
			? listResourcesSummary(client, requestOptions)
			: Promise.resolve({ summary: [], available: false }),
		serverCapabilities?.prompts
			? listPromptsSummary(client, requestOptions)
			: Promise.resolve({ summary: [], available: false }),
	]);
	return {
		capabilities: {
			tools: tools.summary,
			resources: resources.summary,
			prompts: prompts.summary,
		},
		supportedCapabilities: {
			tools: tools.available,
			resources: resources.available,
			prompts: prompts.available,
		},
	};
}

type SdkTransport = DetachedStdioClientTransport | InstanceType<typeof StreamableHTTPClientTransport>;

export async function createMcpClient(config: McpServerConfig, opts: { timeoutMs: number }): Promise<McpClientHandle> {
	const client = new Client({ name: "pi-hub", version: "0.0.0" });
	const transport: SdkTransport =
		config.transport === "stdio"
			? new DetachedStdioClientTransport({
					command: config.command,
					args: config.args,
					cwd: config.cwd,
					env: config.env,
					stderr: "pipe",
				})
			: new StreamableHTTPClientTransport(new URL(config.url), {
					requestInit: config.headers ? { headers: config.headers } : undefined,
				});

	const abort = new AbortController();
	const timeoutId = setTimeout(() => {
		abort.abort();
	}, opts.timeoutMs);

	let closed = false;
	const close = async () => {
		if (closed) {
			return;
		}
		closed = true;
		try {
			await client.close();
		} catch {
			// ignore
		}
	};

	try {
		await client.connect(transport, { signal: abort.signal });
		const { capabilities, supportedCapabilities } = await discoverCapabilities(client, { signal: abort.signal });
		return {
			client,
			capabilities,
			supportedCapabilities,
			transport: config.transport,
			close,
		};
	} catch (e) {
		if (abort.signal.aborted) {
			await close();
			throw new McpClientTimeoutError(opts.timeoutMs);
		}
		await close();
		throw e;
	} finally {
		clearTimeout(timeoutId);
	}
}
