---
title: Agent 工具
sidebar_position: 2
---

# Agent 工具参考

一句话：所有 agent 可调的工具，按多 agent / sources / remote 三类。

## 多 Agent 编排

| 工具 | 用途 | 文档 |
|---|---|---|
| `agent_network` | 查整个 agent 树 | [多 Agent → agent_network](../multi-agent/agent-network) |
| `create_agent` | 创建子 agent | [多 Agent → create_agent](../multi-agent/create-agent) |
| `send_message` | 派活给 agent | [多 Agent → send_message](../multi-agent/send-message) |
| `destroy_agent` | 销毁 agent | [多 Agent → destroy_agent](../multi-agent/destroy-agent) |

## Sources（数据源）

| 工具 | 用途 | 文档 |
|---|---|---|
| `create_source` | 注册 source | [Sources → create_source](../sources/create-source) |
| `subscribe_source` | 订阅 | [Sources → subscribe_source](../sources/subscribe-source) |
| `unsubscribe_source` | 取消订阅 | [Sources → unsubscribe_source](../sources/unsubscribe-source) |
| `list_sources` | 列出 | [Sources → list_sources](../sources/list-sources) |

## Remote Execution（远程工具）

工具名前缀 `remote_`，在 client 机器执行：

| 工具 | 等价 native |
|---|---|
| `remote_bash` | `bash` |
| `remote_read` | `read` |
| `remote_ls` | `ls` |
| `remote_grep` | `grep` |
| `remote_find` | `find` |
| `remote_write` | `write` |
| `remote_edit` | `edit` |

详见 [Remote Execution → remote tools](../remote-execution/remote-tools)。

## pi 原生工具

agent worker 跑在 hub 上，**默认**可以调所有 pi coding-agent 内置工具（`bash` / `read` / `ls` / `grep` / `find` / `write` / `edit`）。
这些工具跑在 **hub 机器**——如果你希望它们跑在 client 机器，调对应的 `remote_*` 版本。

## 相关

- [CLI 命令](./cli)
- [Slash 命令](./slash-commands)

