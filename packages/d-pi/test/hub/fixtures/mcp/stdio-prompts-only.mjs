import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture-prompts-only", version: "1.0.0" });
server.registerPrompt("onlyPrompt", { description: "Sole prompt" }, async () => ({
	messages: [{ role: "user", content: { type: "text", text: "p" } }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
