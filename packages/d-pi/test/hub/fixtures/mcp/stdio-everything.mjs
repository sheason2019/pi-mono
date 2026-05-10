import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture-everything", version: "1.0.0" });
server.registerTool(
	"fixtureTool",
	{ description: "A fixture tool" },
	async () => ({
		content: [{ type: "text", text: "ok" }],
	}),
);
server.registerResource(
	"fixtureRes",
	"fixture://item",
	{ description: "A fixture resource", mimeType: "text/plain" },
	async () => ({
		contents: [{ uri: "fixture://item", text: "content" }],
	}),
);
server.registerPrompt("fixturePrompt", { description: "A fixture prompt" }, async () => ({
	messages: [{ role: "user", content: { type: "text", text: "hi" } }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
