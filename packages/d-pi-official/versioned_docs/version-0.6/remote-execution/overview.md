---
title: 概览
sidebar_position: 1
---

# 远程执行（Remote Execution）

d-pi 的 agent worker 跑在 hub 机器上（可能在云上），但**工具执行**可以路由回 client 机器，
你（client 端）拥有真正的本地文件、shell、env var。

## 架构

```
client (你)                                          hub (云)            
                                                                             
  pi TUI  ─┐                                                                  
           ├─→  executor 子进程  ──→  hub (RPC)  ──→  agent worker (LLM)
           │   (跑 native tools)                                                  
           │                                                                     
  你机器的 bash / read / write  <──返回结果──  hub  <──返回结果──  agent     
```

## 关键点

- **Executor 是 client 端的子进程**，跟 TUI 一起由 `d-pi connect` 拉起
- Executor 持有 pi 的 native tool 集（read / bash / write / ...）
- Hub 把 agent 的 `remote_*` 工具调用路由到 executor
- Agent 看到的 `remote_bash` 跟 native `bash` 用法完全一样——只是**执行位置**在 client

## 工具一览

（agent 视角）

| 工具 | 等价 native |
|---|---|
| `remote_bash` | `bash` |
| `remote_read` | `read` |
| `remote_ls` | `ls` |
| `remote_grep` | `grep` |
| `remote_find` | `find` |
| `remote_write` | `write` |
| `remote_edit` | `edit` |

## 端到端例子

agent 帮你看本地 config：

```
用户：帮我看看 ~/.zshrc 里有没有设置 RUSTUP_HOME
  → agent 调 remote_grep(pattern="RUSTUP_HOME", path="/Users/me/.zshrc")
  → hub 路由到 client executor
  → executor 在你机器上跑 grep /Users/me/.zshrc → RUSTUP_HOME
  → 结果回 agent → agent 答用户
```

## 相关

- [executor 生命周期](./executor-lifecycle) — connect 启停
- [remote tools 详情](./remote-tools)
- [/agents 命令](./slash-agents) — client 端切换 agent

