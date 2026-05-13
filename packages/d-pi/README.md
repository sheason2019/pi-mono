# D-Pi (`@sheason/d-pi`)

D-Pi is the unified CLI for running a Pi hub and connecting terminal peers to it.

It contains the hub runtime and peer TUI directly:

- `d-pi hub ...` runs the workspace-local backend that owns sessions, agents, model state, MCP servers, and sources.
- `d-pi peer ...` runs the terminal UI and local tool executor that connects to a hub.

Use D-Pi when you want one command surface for a multi-agent Pi workspace.

## Quick Start

Install the CLI:

```bash
npm install -g @sheason/d-pi
```

Create and start a hub in your project workspace:

```bash
cd /path/to/your/workspace
d-pi hub init
d-pi hub serve
```

Open another terminal and connect a peer:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

You now have:

- one hub process serving the workspace
- one terminal peer bound to the default `main` agent
- a TUI where you can chat with the agent, select models, inspect sources, inspect MCP servers, and manage the current session

## Installation

### Global Install

```bash
npm install -g @sheason/d-pi
```

Check the installed command:

```bash
d-pi help
```

### Local Development Install

From this monorepo:

```bash
npm install
npm run build --workspace @sheason/d-pi-web-ui
npm run build --workspace @sheason/d-pi
npm link --workspace @sheason/d-pi
```

Hub and peer internals live inside the `@sheason/d-pi` package, so no separate hub or peer binaries need to be linked.

## Core Commands

```bash
d-pi help
d-pi hub <command>
d-pi peer [options]
```

### Hub Commands

Run these from the workspace you want the hub to own.

```bash
d-pi hub init
d-pi hub add-skills
d-pi hub serve
d-pi hub export <archive.tar>
d-pi hub import <archive.tar> [--force]
d-pi hub status
d-pi hub clean
```

`d-pi hub init` creates workspace state under:

- `.pi/agents.json`
- `.pi-hub/session.jsonl`
- `.pi-hub/session-meta.json`

`d-pi hub add-skills` installs built-in guidance skills into `.pi/skills`.

`d-pi hub serve` starts the Socket.IO backend and opens the hub dashboard. By default it listens on `0.0.0.0:4317`, so it is reachable from your LAN.

The same process also serves the built-in Web UI for the `main` agent:

```text
http://127.0.0.1:4317/
```

Open a specific agent by path:

```text
http://127.0.0.1:4317/
http://127.0.0.1:4317/agents/<child-agent-id>
```

The Web UI uses the same-origin Socket.IO/CRDT hub protocol, so no CORS setup is required. It connects as a hub host UI, not as a peer executor, so it is not counted in `peerCount` and cannot run peer-local tools. Use `d-pi peer --agent <id>` when you need peer-local tools.

Override the listen address with environment variables. Use `127.0.0.1` for local-only access:

```bash
PI_HUB_HOST=127.0.0.1 PI_HUB_PORT=4317 d-pi hub serve
```

When using the default LAN binding, browse to `http://<machine-lan-ip>:4317/` from another device.

`d-pi hub export <archive.tar>` writes a tar archive containing the workspace-local hub state and Pi configuration:

- `.pi-hub/` for hub runtime state, session history, and agent state
- `.pi/` for workspace-local Pi configuration, sources, agents, and skills

`d-pi hub import <archive.tar>` restores those directories into the current workspace. It refuses to overwrite an existing `.pi-hub` or `.pi` directory unless `--force` is set:

```bash
d-pi hub import ./workspace.tar --force
```

`d-pi hub status` prints current workspace hub metadata.

`d-pi hub clean` removes hub workspace state.

### Peer Commands

Connect to a local hub:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

Connect to a remote hub:

```bash
d-pi peer --hub http://HOSTNAME_OR_IP:4317 --peer-id laptop
```

Use a display name:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --name "Laptop"
```

Bind the peer to a child agent:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --agent obsidian
```

The peer is bound to one agent for the process lifetime. To switch agents, start another peer process with a different `--agent`.

Install peer-side guidance skills:

```bash
d-pi peer add-skills
```

## TUI Commands

Inside `d-pi peer`, slash commands drive the hub-owned session:

| Command | Purpose |
| --- | --- |
| `/model` | Inspect or switch the active model |
| `/settings` | Inspect supported peer settings |
| `/settings thinking <level>` | Change reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `/compact` | Ask the hub to compact the current session |
| `/reload` | Reload models, settings, sources, MCP servers, skills, and peer config |
| `/group` | Show main/child agents and available tool executors |
| `/session` | Show current session snapshot details |
| `/source` | Show hub and peer-local source processes and status |
| `/mcp` | Show MCP servers, capabilities, and status |
| `/skills` | Show available hub and peer skills |

Branch-oriented single-agent commands such as `/new`, `/resume`, `/tree`, `/fork`, and `/clone` are disabled in the hub/peer runtime.

## Mental Model

One workspace has one hub. The hub owns durable state and all agent sessions.

Peers are frontends and executors:

- The hub stores session history and CRDT view state.
- A peer renders one agent session.
- Peer tools run on the peer machine.
- Hub tools run in the hub workspace.
- Sources and MCP servers are routed by stable `resourceId`s, so different resources can share the same human name without ambiguous ownership.

Agents:

- `main` is created by `d-pi hub init`.
- Child agents live under `.child-agent/<agent-id>/`.
- A peer connects to `main` unless `--agent <id>` is provided.
- Use `/group` to see which agents and peers are available.

## Workspace Configuration

D-Pi uses standard Pi workspace files.

### Models

Workspace model config:

```text
.pi/models.json
```

Models are merged into the hub model registry. Run `/reload` from a peer after editing model config.

### Sources

Hub source config:

```text
.pi/sources.json
```

A source is a long-running process that writes line-delimited JSON-RPC notifications to stdout.

Minimal source:

```json
[
  {
    "name": "local-source",
    "transport": "stdio",
    "command": "node",
    "args": [".pi/local-source.cjs"]
  }
]
```

Source stdout must use `queue/write`:

```json
{"jsonrpc":"2.0","method":"queue/write","params":{"content":"hello from source"}}
```

Rules:

- stdout is reserved for JSON-RPC notifications
- logs should go to stderr
- `params.content` must be a string
- `params.delivery` is not supported
- the target agent defaults to `main`

To target a child agent directly:

```json
[
  {
    "name": "child-source",
    "transport": "stdio",
    "command": "node",
    "args": [".pi/child-source.cjs"],
    "agentId": "obsidian"
  }
]
```

To let a child agent inherit a host source as its own independent instance:

```json
{
  "extends": {
    "host": {
      "sources": ["lark-message-watcher"]
    }
  },
  "sources": []
}
```

Save that as:

```text
.child-agent/<agent-id>/sources.json
```

After editing sources, run `/reload` from a peer or restart the hub.

### MCP Servers

Hub MCP config:

```text
.pi/mcp.json
```

Example stdio server:

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

Example HTTP server:

```json
{
  "servers": [
    {
      "name": "remote",
      "transport": "http",
      "url": "https://example.com/mcp"
    }
  ]
}
```

Use `/mcp` to inspect status and capabilities. Use `/reload` after editing MCP config.

### Skills

Workspace skills:

```text
.pi/skills/<skill-name>/SKILL.md
```

Child-local skills:

```text
.child-agent/<agent-id>/skills/<skill-name>/SKILL.md
```

Install built-in guidance skills:

```bash
d-pi hub add-skills
d-pi peer add-skills
```

Use `/skills` in the peer to inspect the effective skill set.

## Subscribe to Lark Messages

This section shows how to turn Lark messages into Pi source messages.

The pipeline is:

```text
Lark Open Platform
  -> lark-cli event +subscribe
  -> .pi/lark-message-source.cjs
  -> stdout queue/write
  -> D-Pi hub source host
  -> target agent queue
```

### 1. Install and Configure `lark-cli`

Install `lark-cli` following the Lark CLI documentation, then initialize app config:

```bash
lark-cli config init --new
```

Lark event subscription uses bot identity. User login is not required for the WebSocket event connection.

### 2. Configure Lark Open Platform

In the Lark Open Platform console:

1. Open your app.
2. Go to Events & Callbacks.
3. Set the subscription method to long connection.
4. Add the event type:

```text
im.message.receive_v1
```

5. Enable the required permission:

```text
im:message:receive_as_bot
```

6. Add the bot to the chats where it should receive messages.

### 3. Test the Lark Event Stream

Run:

```bash
lark-cli event +subscribe \
  --as bot \
  --event-types im.message.receive_v1 \
  --compact \
  --quiet
```

Expected output is NDJSON, one event per line:

```json
{"type":"im.message.receive_v1","message_id":"om_xxx","chat_id":"oc_xxx","chat_type":"p2p","message_type":"text","content":"Hello","sender_id":"ou_xxx","timestamp":"1773491924409"}
```

Important: do not run multiple subscribers for the same app unless you know what you are doing. Lark can split events across multiple long-connection clients. `lark-cli event +subscribe` protects this by default; avoid `--force` for Pi sources.

### 4. Create a Pi Source Wrapper

Create `.pi/lark-message-source.cjs`:

```js
#!/usr/bin/env node
const { spawn } = require("node:child_process");

const eventTypes = process.env.LARK_EVENT_TYPES || "im.message.receive_v1";
const larkCli = process.env.LARK_CLI_PATH || "lark-cli";

function writeQueueMessage(content) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "queue/write",
      params: { content },
    })}\n`,
  );
}

function start() {
  const args = [
    "event",
    "+subscribe",
    "--as",
    "bot",
    "--event-types",
    eventTypes,
    "--compact",
    "--quiet",
  ];

  console.error(`[lark-source] starting: ${larkCli} ${args.join(" ")}`);

  const child = spawn(larkCli, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const content = event.content || "";
        if (!content) continue;

        writeQueueMessage(
          [
            "Received Lark message",
            `type: ${event.type || "unknown"}`,
            `chat: ${event.chat_type || "unknown"}`,
            `sender: ${event.sender_id || "unknown"}`,
            `message_id: ${event.message_id || ""}`,
            `content: ${content}`,
          ].join("\n"),
        );
      } catch (error) {
        console.error(`[lark-source] failed to parse event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) console.error(`[lark-source] ${text}`);
  });

  child.once("error", (error) => {
    console.error(`[lark-source] process error: ${error instanceof Error ? error.message : String(error)}`);
    setTimeout(start, 3000);
  });

  child.once("exit", (code, signal) => {
    console.error(`[lark-source] exited code=${code ?? ""} signal=${signal ?? ""}; restarting in 3s`);
    setTimeout(start, 3000);
  });

  const stop = () => {
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1000);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

start();
```

Make it executable if you want to run it directly:

```bash
chmod +x .pi/lark-message-source.cjs
```

### 5. Register the Source

Create or update `.pi/sources.json`:

```json
[
  {
    "name": "lark-message-watcher",
    "transport": "stdio",
    "command": "node",
    "args": [".pi/lark-message-source.cjs"],
    "env": {
      "LARK_EVENT_TYPES": "im.message.receive_v1"
    }
  }
]
```

Start or reload the hub:

```bash
d-pi hub serve
```

Or, from an existing peer:

```text
/reload
```

Inspect the source:

```text
/source
```

The source should move to `running`. When the bot receives a Lark message, the hub enqueues it as a user message with source metadata:

```text
source/lark-message-watcher
```

### 6. Route Lark Messages to a Child Agent

To give a child agent its own Lark watcher instance, create:

```text
.child-agent/obsidian/sources.json
```

with:

```json
{
  "extends": {
    "host": {
      "sources": ["lark-message-watcher"]
    }
  },
  "sources": []
}
```

Then reload or restart the hub. The hub will run a separate child-scoped source instance:

```text
main:     lark-message-watcher
obsidian: lark-message-watcher
```

Each instance has a distinct internal `resourceId`; the display name stays human-readable.

Connect a peer to that child agent:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --agent obsidian
```

Run `/source` from that peer. It should show the child-owned `lark-message-watcher`, not the main agent's source.

## Common Workflows

### Start a Local Workspace

```bash
cd /path/to/workspace
d-pi hub init
d-pi hub add-skills
d-pi hub serve
```

In another terminal:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

### Connect from Another Machine

On the hub machine:

```bash
PI_HUB_HOST=0.0.0.0 PI_HUB_PORT=4317 d-pi hub serve
```

On the peer machine:

```bash
d-pi peer --hub http://HUB_IP_OR_DNS:4317 --peer-id remote-laptop
```

Make sure your network and firewall allow access to the hub port.

### Export and Import a Hub Workspace

Use a workspace archive to move or copy a hub between machines. The archive includes both durable hub state and workspace-local Pi configuration.

On the source machine:

```bash
cd /path/to/workspace
d-pi hub export ./workspace.tar
```

Copy `workspace.tar` to the target machine, then import it from the target workspace directory:

```bash
mkdir -p /path/to/restored-workspace
cd /path/to/restored-workspace
d-pi hub import /path/to/workspace.tar
```

If the target already has `.pi-hub` or `.pi`, import fails by default. Use `--force` only when you want to replace the existing workspace state:

```bash
d-pi hub import /path/to/workspace.tar --force
```

After importing, start the hub and connect a peer:

```bash
d-pi hub serve
d-pi peer --hub http://127.0.0.1:4317 --peer-id restored
```

### Run Hub Continuously with pm2

D-Pi does not publish an official Docker image yet. For a simple long-running hub process, use `pm2` and keep the workspace directory mounted on the host machine.

Install `pm2` if needed:

```bash
npm install -g pm2
```

Initialize the workspace once:

```bash
cd /path/to/workspace
d-pi hub init
d-pi hub add-skills
```

Start the hub in the background:

```bash
pm2 start "$(which d-pi)" \
  --name d-pi-hub \
  --cwd /path/to/workspace \
  -- hub serve
```

For remote peers, expose the hub on the host network:

```bash
PI_HUB_HOST=0.0.0.0 PI_HUB_PORT=4317 pm2 start "$(which d-pi)" \
  --name d-pi-hub \
  --cwd /path/to/workspace \
  -- hub serve
```

Persist the process across machine restarts:

```bash
pm2 save
pm2 startup
```

Common operations:

```bash
pm2 logs d-pi-hub
pm2 restart d-pi-hub
pm2 stop d-pi-hub
```

### Create and Use Child Agents

Use the main agent's child-agent tools from the conversation:

- `create_child_agent`
- `stop_child_agent`
- `start_child_agent`
- `remove_child_agent`
- `search_memory`
- `list_memory`

Use `/group` to inspect all known agents and connected peers.

A child peer connects with:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --agent <child-id>
```

## Troubleshooting

### `d-pi peer` cannot connect

Check that the hub is running:

```bash
d-pi hub status
d-pi hub serve
```

Check the peer URL:

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

For remote peers, check `PI_HUB_HOST`, firewalls, and the hub machine's IP address.

### `/source` shows a source but the child agent does not receive messages

The peer only receives sources owned by the bound agent.

For a child agent, either:

- set `agentId` on a source entry in `.pi/sources.json`, or
- create `.child-agent/<agent-id>/sources.json` with `extends.host.sources`

Then run `/reload` or restart the hub.

### Lark source starts but no events arrive

Check:

- the bot is added to the target chat
- long-connection subscription is enabled in the Lark Open Platform console
- `im.message.receive_v1` is configured in the event list
- `im:message:receive_as_bot` permission is enabled
- `lark-cli event +subscribe --as bot --event-types im.message.receive_v1 --compact --quiet` prints events outside Pi

### Lark source exits or reports parse errors

Run the wrapper directly:

```bash
node .pi/lark-message-source.cjs
```

Logs should appear on stderr. Stdout must contain only one-line JSON-RPC `queue/write` notifications.

### Model, MCP, source, or skill changes do not appear

Run:

```text
/reload
```

If the resource still does not appear, restart the hub.

## Package Relationship

`@sheason/d-pi` is the only distributed package for the D-Pi runtime. The hub and peer implementations are maintained as internal modules and are invoked in-process by the `d-pi` binary.

Use D-Pi for the stable user-facing command surface.
