---
title: Agent 工具
sidebar_position: 2
---

# Agent工具参考

一句话：所有 agent可调的工具，按多 agent / sources / remote三类。

##多 Agent编排

|工具 |用途 |文档 |
|---|---|---|
| `group_architecture` |查整个 agent树 | [多 Agent → group_architecture](../multi-agent/group-architecture) |
| `create_agent` |创建子 agent | [多 Agent → create_agent](../multi-agent/create-agent) |
| `send_message` |派活给 agent | [多 Agent → send_message](../multi-agent/send-message) |
| `destroy_agent` |销毁 agent | [多 Agent → destroy_agent](../multi-agent/destroy-agent) |

## Sources（数据源）

|工具 |用途 |文档 |
|---|---|---|
| `create_source` |注册 source | [Sources → create_source](../sources/create-source) |
| `subscribe_source` |订阅 | [Sources → subscribe_source](../sources/subscribe-source) |
| `unsubscribe_source` |取消订阅 | [Sources → unsubscribe_source](../sources/unsubscribe-source) |
| `list_sources` |列出 | [Sources → list_sources](../sources/list-sources) |
| `destroy_source` |销毁 source | [Sources → destroy_source](../sources/destroy-source) |

## Remote Execution（远程工具）

工具名前缀 `remote_`，在 client机器执行：

|工具 |等价 native |
|---|---|
| `remote_bash` | `bash` |
| `remote_read` | `read` |
| `remote_ls` | `ls` |
| `remote_grep` | `grep` |
| `remote_find` | `find` |
| `remote_write` | `write` |
| `remote_edit` | `edit` |

详见 [Remote Execution → remote tools](../remote-execution/remote-tools)。

## Runtime工具（reload）

|工具 |用途 |文档 |
|---|---|---|
| `reload` |运行时重新加载 skills / system prompt / AGENTS.md / extensions | [reload](./reload) |

`reload` 是 PR23 inline extension引入的 LLM-callable工具，让 agent 不重启 hub也能刷新自己的上下文资源。但 **不**触发 `group-architecture/roles/<role>/` 重读——role目录加载发生在 agent创建时，role修改仍需 destroy+recreate 或重启 hub。

## pi原生工具

agent worker跑在 hub上，**默认**可以调所有 pi coding-agent内置工具（`bash` / `read` / `ls` / `grep` / `find` / `write` / `edit`）。
这些工具跑在 **hub机器**——如果你希望它们跑在 client机器，调对应的 `remote_*` 版本。

## 相关

- [CLI命令](./cli)
- [Slash命令](./slash-commands)
