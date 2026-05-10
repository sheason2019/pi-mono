import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], {
	stdio: "ignore",
});

if (process.env.PI_MCP_CHILD_PID_FILE) {
	writeFileSync(process.env.PI_MCP_CHILD_PID_FILE, `${child.pid ?? ""}`, "utf8");
}

const server = new McpServer({ name: "fixture-spawns-child", version: "1.0.0" });
server.registerTool("fixtureTool", { description: "A fixture tool" }, async () => ({
	content: [{ type: "text", text: "ok" }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
