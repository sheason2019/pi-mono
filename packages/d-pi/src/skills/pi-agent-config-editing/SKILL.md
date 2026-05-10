---
name: pi-agent-config-editing
description: Use when editing D-Pi hub or peer MCP servers, skills, sources, or agent resource configuration
---

# Pi Agent Config Editing

## Overview

Pi has two resource planes. Hub resources run in `d-pi hub`; peer resources run in `d-pi peer` and are sent to the hub as a peer config snapshot. Always edit the plane that should own the tool, skill, or source, then reload the running agent.

This skill covers the on-disk formats and the small runtime protocols for MCP, Sources, and Skills. Do not guess these formats from older pi docs: `d-pi hub` and `d-pi peer` intentionally use a narrower current protocol.

## Install This Skill

From a workspace where the agent should see the guidance:

```bash
d-pi hub add-skills
d-pi peer add-skills
```

Both commands install this skill to `.pi/skills/pi-agent-config-editing/SKILL.md` in the current working directory.

## Config Matrix

| Owner | MCP | Sources | Skills |
| --- | --- | --- | --- |
| Hub main agent | `.pi/mcp.json` | `.pi/sources.json` | `.pi/skills/<name>/SKILL.md` |
| Hub child agent | `.child-agent/<agent-id>/mcp.json` | `.pi/sources.json` with `agentId` | `.child-agent/<agent-id>/skills/<name>/SKILL.md` |
| Peer project | `.pi/mcp.json` | `.pi/sources.json` | `.pi/skills/<name>/SKILL.md` |
| Peer global/user | agent/global config dir | agent/global config dir | `skills/<name>/SKILL.md` under that dir |

Use hub paths for tools that must run on the hub host. Use peer paths for tools that must run where `d-pi peer` is running.

Peer source lookup order:

1. `<agentDir>/sources.json`
2. `<globalDir>/sources.json`
3. `<peer cwd>/.pi/sources.json`

Peer skills are loaded from `skills/<name>/SKILL.md` under the same global/agent config layers and from `<peer cwd>/.pi/skills/<name>/SKILL.md`.

## MCP

Hub and peer MCP files accept either a root array or an object with `servers`:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  ]
}
```

Each server entry supports:

- `name`: non-empty, matches `^[a-zA-Z0-9_-]+$`, and must not contain `__`
- `transport`: `"stdio"` or `"http"`
- stdio fields: `command`, optional `args`, optional `cwd`, optional `env`
- http fields: `url`, optional `headers`
- optional `disabled`

Do not write hub MCP as `{ "mcpServers": ... }`; hub parsing expects `servers` or a root array.

### MCP Server Implementation

Prefer the official SDK. A stdio MCP server can be as small as:

```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.registerTool("hello", { description: "Say hello" }, async () => ({
  content: [{ type: "text", text: "hello" }]
}));

server.registerResource(
  "notes",
  "demo://notes",
  { description: "Demo notes", mimeType: "text/plain" },
  async () => ({ contents: [{ uri: "demo://notes", text: "notes" }] })
);

server.registerPrompt("review", { description: "Review prompt" }, async () => ({
  messages: [{ role: "user", content: { type: "text", text: "Review this." } }]
}));

await server.connect(new StdioServerTransport());
```

Configure it:

```json
{
  "servers": [
    {
      "name": "demo",
      "transport": "stdio",
      "command": "node",
      "args": [".pi/mcp-demo.mjs"],
      "env": { "EXAMPLE": "1" }
    }
  ]
}
```

For HTTP MCP, use Streamable HTTP (`StreamableHTTPServerTransport`) and configure:

```json
{
  "servers": [
    {
      "name": "remote",
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  ]
}
```

Low-level MCP is JSON-RPC 2.0. The client initializes, then lists/calls tools and reads resources/prompts. If you are not using the SDK, implement at least `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, and optionally `resources/list`, `resources/read`, `prompts/list`, `prompts/get`. Tool results must return MCP content blocks such as `{ "type": "text", "text": "..." }`.

## Sources

Sources are stdio processes configured in `sources.json`. The file may be a root array or an object with `sources`:

```json
[
  {
    "name": "timer",
    "transport": "stdio",
    "command": "node",
    "args": [".pi/timer-source.js"],
    "cwd": ".",
    "env": { "INTERVAL_MS": "60000" },
    "agentId": "main"
  }
]
```

Each source entry supports:

- `name`: non-empty string, unique within that file
- `transport`: currently only `"stdio"`
- `command`: executable
- optional `args`: string array
- optional `cwd`: process working directory; omitted uses the hub/peer cwd
- optional `env`: object of string keys and string values
- optional `agentId`: omitted targets `main`
- optional `disabled`: when `true`, keep config but do not spawn

For child agents, keep the source in hub or peer `sources.json` and set `agentId` to the child id.

### Source Runtime Protocol

Current `d-pi hub` / `d-pi peer` sources do not use a bidirectional subscription protocol. There is no initialize/source/subscribe/source/message handshake and no source capabilities response.

A source writes newline-delimited JSON-RPC 2.0 notifications to stdout. The only supported method is `queue/write`:

```javascript
function send(content) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "queue/write",
      params: { content }
    })}\n`
  );
}

send("Build finished. Please inspect the result.");
```

Rules:

- Omit `id`; source lines must be notifications, not requests.
- `jsonrpc` must be `"2.0"`.
- `method` must be `"queue/write"`.
- `params.content` must be a string.
- `params.delivery` is not supported; all source messages are queued.
- Each notification must be one complete line on stdout.
- Stderr is diagnostic output and is not added to the conversation.

### Source Environment

The spawned process receives the parent process environment plus the entry's `env` object. Config values override parent values. No automatic PI_SOURCE_* variables are injected. If the source needs its name, agent id, hub URL, or workspace path, put those values explicitly in `env` or `args`.

## Skills

Each skill is a directory containing `SKILL.md` with YAML frontmatter:

```markdown
---
name: example-skill
description: Use when the agent needs this workflow
---

# Example Skill
```

Only `name` and `description` are required in frontmatter. Keep `name` lowercase kebab-case. The description should start with `Use when...` and describe trigger conditions.

Relative files in skills are resolved against the skill directory: the parent directory of `SKILL.md`. If a skill says `see reference.md`, tools should read `<skill-dir>/reference.md`.

Put hub-owned skills in hub paths and peer-owned skills in peer paths. When resources are aggregated, hub resources and peer resources may be prefixed in the runtime view; do not rename files just to match runtime prefixes.

Example with a supporting reference file:

```text
.pi/skills/example-skill/
  SKILL.md
  reference.md
```

Inside `SKILL.md`, say `Read reference.md for details`; the agent must resolve that as `.pi/skills/example-skill/reference.md`.

## Reload And Verify

After editing files:

1. In `d-pi peer`, run `/reload` from the TUI.
2. In `d-pi hub`, ask the agent to use the `reload_config` tool or restart `d-pi hub serve`.
3. Use `/mcp`, `/source`, and `/skills` in `d-pi peer` to verify the runtime view.
4. If a tool is missing, check the owner plane first: hub-local tools belong in hub config; peer-local tools belong in peer config.

## Common Mistakes

- Editing hub `.pi/mcp.json` when the desired executor is a peer.
- Editing peer `.pi/skills` and expecting a disconnected peer to update the hub.
- Forgetting `agentId` for child-agent sources.
- Writing `mcpServers` in hub config.
- Implementing an old Source handshake (`initialize`, `source/subscribe`, `source/message`) instead of stdout `queue/write`.
- Expecting built-in source environment variables; pass required values through `env` or `args`.
- Assuming file edits are live without `/reload` or `reload_config`.
