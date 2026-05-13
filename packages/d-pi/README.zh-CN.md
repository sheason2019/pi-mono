# D-Pi (`@sheason/d-pi`) 中文用户手册

D-Pi 是 Pi Hub/Peer 运行时的统一命令行入口，用于启动工作区内的 hub 后端，并连接一个或多个 terminal peer。

它直接内置 hub runtime 和 peer TUI：

- `d-pi hub ...` 运行工作区后端，负责会话、agent、模型、MCP、source 和资源路由。
- `d-pi peer ...` 运行终端 TUI 和本机工具执行器，并连接到 hub。

如果你希望用一个稳定命令管理多 agent Pi 工作区，请优先使用 D-Pi。

## 快速开始

安装：

```bash
npm install -g @sheason/d-pi
```

进入你的项目工作区，初始化并启动 hub：

```bash
cd /path/to/your/workspace
d-pi hub init
d-pi hub serve
```

打开另一个终端，连接 peer：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

此时你已经拥有：

- 一个服务当前工作区的 hub 进程
- 一个连接到默认 `main` agent 的终端 peer
- 一个可交互 TUI，可用于对话、切换模型、查看 source、查看 MCP、查看 skills 和管理当前会话

## 安装

### 全局安装

```bash
npm install -g @sheason/d-pi
```

检查命令是否可用：

```bash
d-pi help
```

### 本仓库开发安装

在 `pi-mono` 仓库内：

```bash
npm install
npm run build --workspace @sheason/d-pi-web-ui
npm run build --workspace @sheason/d-pi
npm link --workspace @sheason/d-pi
```

Hub 和 peer 内部实现都在 `@sheason/d-pi` 包内维护，不需要单独 link hub 或 peer 二进制。

## 命令概览

```bash
d-pi help
d-pi hub <command>
d-pi peer [options]
```

### Hub 命令

Hub 命令应在你希望由 Pi 管理的工作区目录中执行。

```bash
d-pi hub init
d-pi hub add-skills
d-pi hub serve
d-pi hub export <archive.tar>
d-pi hub import <archive.tar> [--force]
d-pi hub status
d-pi hub clean
```

`d-pi hub init` 会创建工作区状态：

- `.pi/agents.json`
- `.pi-hub/session.jsonl`
- `.pi-hub/session-meta.json`

`d-pi hub add-skills` 会把内置指导 skills 安装到 `.pi/skills`。

`d-pi hub serve` 会启动 Socket.IO 后端，并打开 hub dashboard。默认监听地址是：

```text
0.0.0.0:4317
```

因此默认可以从局域网访问。

同一个进程也会托管内置 Web UI，可在浏览器中访问 `main` agent：

```text
http://127.0.0.1:4317/
```

也可以通过路径打开指定 agent：

```text
http://127.0.0.1:4317/
http://127.0.0.1:4317/agents/<child-agent-id>
```

Web UI 使用同源 Socket.IO/CRDT hub 协议，因此不需要配置 CORS。它以 hub host UI 身份连接，不是 peer executor，因此不会计入 `peerCount`，也不能执行 peer-local tools。需要 peer-local tools 时请使用 `d-pi peer --agent <id>`。

你可以通过环境变量修改监听地址。需要只允许本机访问时，显式使用 `127.0.0.1`：

```bash
PI_HUB_HOST=127.0.0.1 PI_HUB_PORT=4317 d-pi hub serve
```

使用默认局域网监听时，其他设备访问 `http://<机器局域网 IP>:4317/`。

`d-pi hub export <archive.tar>` 会写出一个 tar 归档，包含当前工作区的 hub 状态和 Pi 配置：

- `.pi-hub/`：hub runtime state、session history 和 agent state
- `.pi/`：工作区本地 Pi 配置、sources、agents 和 skills

`d-pi hub import <archive.tar>` 会把这些目录恢复到当前工作区。默认情况下，如果目标已存在 `.pi-hub` 或 `.pi`，导入会失败；只有显式传入 `--force` 才会覆盖：

```bash
d-pi hub import ./workspace.tar --force
```

`d-pi hub status` 用于查看当前工作区的 hub 状态。

`d-pi hub clean` 会删除当前工作区的 hub 状态。

### Peer 命令

连接本机 hub：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

连接远程 hub：

```bash
d-pi peer --hub http://HOSTNAME_OR_IP:4317 --peer-id laptop
```

设置显示名：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --name "Laptop"
```

绑定到 child agent：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --agent obsidian
```

一个 peer 进程在生命周期内只绑定一个 agent。要切换 agent，请重新启动 peer，并指定新的 `--agent`。

安装 peer 侧内置 skills：

```bash
d-pi peer add-skills
```

## TUI 常用命令

在 `d-pi peer` 的交互界面中，可以使用以下 slash commands：

| 命令 | 作用 |
| --- | --- |
| `/model` | 查看或切换当前模型 |
| `/settings` | 查看支持的设置 |
| `/settings thinking <level>` | 调整推理强度，可选 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `/compact` | 请求 hub 压缩当前会话 |
| `/reload` | 重新加载模型、设置、sources、MCP、skills 和 peer 配置 |
| `/group` | 查看 main/child agents 和可用工具执行器 |
| `/session` | 查看当前会话快照信息 |
| `/source` | 查看 hub 和 peer-local source 进程状态 |
| `/mcp` | 查看 MCP servers、能力和状态 |
| `/skills` | 查看当前可用的 hub/peer skills |

在 hub/peer 运行时中，以下单 agent 分支命令被禁用：

```text
/new
/resume
/tree
/fork
/clone
```

## 核心概念

一个工作区对应一个 hub。Hub 负责持久化状态和所有 agent 会话。

Peer 是前端和执行器：

- Hub 保存 session history 和 CRDT view state。
- Peer 渲染某一个 agent 的会话。
- Peer tools 在 peer 所在机器上执行。
- Hub tools 在 hub 工作区内执行。
- Sources 和 MCP servers 使用稳定 `resourceId` 路由，因此多个资源可以共享同一个人类可读名称，而不会产生所有权歧义。

Agents：

- `main` 由 `d-pi hub init` 创建。
- Child agents 存放在 `.child-agent/<agent-id>/`。
- Peer 默认连接 `main`。
- 指定 `--agent <id>` 可连接到 child agent。
- 使用 `/group` 可以查看当前所有 agent 和已连接 peers。

## 工作区配置

D-Pi 使用标准 Pi 工作区配置文件。

### 模型配置

工作区模型配置文件：

```text
.pi/models.json
```

模型配置会合并进 hub 的模型注册表。修改后，在 peer 中运行：

```text
/reload
```

### Sources

Hub source 配置文件：

```text
.pi/sources.json
```

Source 是一个长运行进程。它通过 stdout 输出按行分隔的 JSON-RPC 通知，hub 读取这些通知并写入目标 agent 队列。

最小示例：

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

Source stdout 必须输出 `queue/write`：

```json
{"jsonrpc":"2.0","method":"queue/write","params":{"content":"hello from source"}}
```

规则：

- stdout 只用于 JSON-RPC 通知
- 日志应写到 stderr
- `params.content` 必须是字符串
- 不支持 `params.delivery`
- 如果未指定目标 agent，默认写入 `main`

直接投递到 child agent：

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

让 child agent 继承 host source，并启动自己的独立实例：

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

保存到：

```text
.child-agent/<agent-id>/sources.json
```

修改 sources 后，可以在 peer 中执行 `/reload`，或者重启 hub。

### MCP Servers

Hub MCP 配置文件：

```text
.pi/mcp.json
```

stdio server 示例：

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

HTTP server 示例：

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

使用 `/mcp` 查看 MCP 状态和能力。修改 `.pi/mcp.json` 后执行 `/reload`。

### Skills

工作区 skills：

```text
.pi/skills/<skill-name>/SKILL.md
```

Child-local skills：

```text
.child-agent/<agent-id>/skills/<skill-name>/SKILL.md
```

安装内置指导 skills：

```bash
d-pi hub add-skills
d-pi peer add-skills
```

使用 `/skills` 查看当前 agent 可用的 skills。

## 订阅飞书消息源

本节说明如何把飞书消息转换成 Pi source 消息。

整体链路：

```text
飞书开放平台
  -> lark-cli event +subscribe
  -> .pi/lark-message-source.cjs
  -> stdout queue/write
  -> D-Pi hub source host
  -> 目标 agent 队列
```

### 1. 安装并配置 `lark-cli`

按照 Lark CLI 文档安装 `lark-cli`，然后初始化应用配置：

```bash
lark-cli config init --new
```

飞书事件订阅使用 bot 身份。WebSocket 长连接不需要用户登录。

### 2. 配置飞书开放平台

在飞书开放平台控制台中：

1. 打开你的应用。
2. 进入事件与回调。
3. 将订阅方式设置为长连接。
4. 添加事件类型：

```text
im.message.receive_v1
```

5. 开通权限：

```text
im:message:receive_as_bot
```

6. 将 bot 添加到需要监听的会话或群聊中。

### 3. 测试飞书事件流

运行：

```bash
lark-cli event +subscribe \
  --as bot \
  --event-types im.message.receive_v1 \
  --compact \
  --quiet
```

预期输出是 NDJSON，每行一个事件：

```json
{"type":"im.message.receive_v1","message_id":"om_xxx","chat_id":"oc_xxx","chat_type":"p2p","message_type":"text","content":"Hello","sender_id":"ou_xxx","timestamp":"1773491924409"}
```

注意：不要为同一个应用同时运行多个订阅进程。飞书长连接可能把事件分发到不同连接，导致每个进程只收到一部分事件。Pi source 不应使用 `--force`。

### 4. 创建 Pi Source Wrapper

创建 `.pi/lark-message-source.cjs`：

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
            "收到飞书消息",
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

如果你希望直接执行这个脚本，添加执行权限：

```bash
chmod +x .pi/lark-message-source.cjs
```

### 5. 注册 Source

创建或更新 `.pi/sources.json`：

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

启动或重新加载 hub：

```bash
d-pi hub serve
```

如果 hub 已经在运行，也可以在 peer 中执行：

```text
/reload
```

查看 source 状态：

```text
/source
```

当 source 状态变为 `running` 后，bot 收到飞书消息时，hub 会把它作为带 source metadata 的 user message 写入 agent 队列：

```text
source/lark-message-watcher
```

### 6. 把飞书消息路由到 Child Agent

如果希望 child agent 拥有自己的飞书消息监听实例，创建：

```text
.child-agent/obsidian/sources.json
```

内容：

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

然后执行 `/reload` 或重启 hub。Hub 会启动 child-scoped source 实例：

```text
main:     lark-message-watcher
obsidian: lark-message-watcher
```

两个实例内部使用不同 `resourceId`，但展示名保持为用户配置的原始名称。

连接到该 child agent：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --agent obsidian
```

在该 peer 中执行 `/source`。它应只显示属于 `obsidian` 的 `lark-message-watcher`，而不是 main agent 的 source。

## 常见工作流

### 启动本地工作区

```bash
cd /path/to/workspace
d-pi hub init
d-pi hub add-skills
d-pi hub serve
```

另开一个终端：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

### 从另一台机器连接

Hub 机器：

```bash
PI_HUB_HOST=0.0.0.0 PI_HUB_PORT=4317 d-pi hub serve
```

Peer 机器：

```bash
d-pi peer --hub http://HUB_IP_OR_DNS:4317 --peer-id remote-laptop
```

请确保网络和防火墙允许访问 hub 端口。

### 导出和导入 Hub 工作区

可以使用 workspace archive 在机器之间迁移或复制 hub。归档同时包含持久化 hub 状态和工作区本地 Pi 配置。

在源机器上：

```bash
cd /path/to/workspace
d-pi hub export ./workspace.tar
```

将 `workspace.tar` 复制到目标机器，然后在目标工作区目录中导入：

```bash
mkdir -p /path/to/restored-workspace
cd /path/to/restored-workspace
d-pi hub import /path/to/workspace.tar
```

如果目标目录已经存在 `.pi-hub` 或 `.pi`，导入默认会失败。只有在确认要替换现有工作区状态时才使用 `--force`：

```bash
d-pi hub import /path/to/workspace.tar --force
```

导入后启动 hub 并连接 peer：

```bash
d-pi hub serve
d-pi peer --hub http://127.0.0.1:4317 --peer-id restored
```

### 使用 pm2 长期运行 Hub

D-Pi 目前还没有发布官方 Docker 镜像。如果只是希望让 hub 在机器后台长期运行，推荐使用 `pm2`，并让工作区目录保留在宿主机上。

如果还没有安装 `pm2`：

```bash
npm install -g pm2
```

先初始化工作区：

```bash
cd /path/to/workspace
d-pi hub init
d-pi hub add-skills
```

后台启动 hub：

```bash
pm2 start "$(which d-pi)" \
  --name d-pi-hub \
  --cwd /path/to/workspace \
  -- hub serve
```

如果需要让其他机器连接 hub，请监听宿主机网络：

```bash
PI_HUB_HOST=0.0.0.0 PI_HUB_PORT=4317 pm2 start "$(which d-pi)" \
  --name d-pi-hub \
  --cwd /path/to/workspace \
  -- hub serve
```

让进程在机器重启后自动恢复：

```bash
pm2 save
pm2 startup
```

常用运维命令：

```bash
pm2 logs d-pi-hub
pm2 restart d-pi-hub
pm2 stop d-pi-hub
```

### 创建和使用 Child Agents

在 main agent 会话中可以使用 child-agent 管理工具：

- `create_child_agent`
- `stop_child_agent`
- `start_child_agent`
- `remove_child_agent`
- `search_memory`
- `list_memory`

使用 `/group` 查看所有已知 agents 和 connected peers。

连接 child agent：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop --agent <child-id>
```

## 故障排查

### `d-pi peer` 无法连接

确认 hub 正在运行：

```bash
d-pi hub status
d-pi hub serve
```

确认 peer URL 正确：

```bash
d-pi peer --hub http://127.0.0.1:4317 --peer-id laptop
```

如果是远程 peer，请检查 `PI_HUB_HOST`、防火墙和 hub 机器 IP。

### `/source` 能看到 source，但 child agent 收不到消息

Peer 只显示当前绑定 agent 拥有的 sources。

对于 child agent，需要满足以下任一条件：

- 在 `.pi/sources.json` 的 source entry 中设置 `agentId`
- 创建 `.child-agent/<agent-id>/sources.json` 并配置 `extends.host.sources`

修改后执行 `/reload` 或重启 hub。

### Lark source 启动了，但没有事件

检查：

- bot 已加入目标私聊或群聊
- 飞书开放平台已启用长连接订阅
- 事件列表中已配置 `im.message.receive_v1`
- 权限中已开通 `im:message:receive_as_bot`
- 在 Pi 外部运行 `lark-cli event +subscribe --as bot --event-types im.message.receive_v1 --compact --quiet` 可以收到事件

### Lark source 退出或出现解析错误

直接运行 wrapper：

```bash
node .pi/lark-message-source.cjs
```

日志应该写入 stderr。stdout 必须只包含单行 JSON-RPC `queue/write` 通知。

### 模型、MCP、source 或 skill 修改后没有出现

在 peer 中执行：

```text
/reload
```

如果仍未出现，重启 hub。

## 包关系

`@sheason/d-pi` 是 D-Pi runtime 唯一分发的包。Hub 和 peer 实现作为内部模块维护，并由 `d-pi` binary 在同一进程内调用。

建议用户使用 D-Pi 作为稳定入口。
