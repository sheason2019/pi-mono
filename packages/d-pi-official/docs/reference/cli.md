---
title: CLI命令
sidebar_position: 1
---

# CLI命令参考

一句话：所有 `d-pi <command>` 的清单。

##顶层命令

|命令 |用途 |文档 |
|---|---|---|
| `d-pi init` |在当前目录创建 d-pi workspace | [快速上手 → init](../getting-started/init) |
| `d-pi serve` |启动 hub | [快速上手 → serve](../getting-started/serve) |
| `d-pi connect` |连到 hub进入 TUI | [快速上手 → connect](../getting-started/connect) |

##用户管理

### `d-pi users`

|子命令 |说明 |
|---|---|
| `d-pi users create <name>` |创建本地用户 |
| `d-pi users list` |列出 |
| `d-pi users update <name>` |更新 |
| `d-pi users delete <name>` |删除 |

详见 [用户管理](../auth/users)。

### `d-pi allow-user`

|子命令 |说明 |
|---|---|
| `d-pi allow-user add <name>` |加入白名单 |
| `d-pi allow-user list` |列出 |
| `d-pi allow-user update <name>` |更新 |
| `d-pi allow-user remove <name>` |移除 |

详见 [允许的用户](../auth/allow-user)。

## 全局标志

**注意**: `d-pi` CLI **当前不实现** `--help / -h` 或 `--version / -V` 全局 flag。跑无参数 `d-pi`走 `printHelp()` (`cli-runner.ts:printHelp`)，列出 CLI概要。版本信息由 npm 包自带。

##环境变量

|变量 |用途 |
|---|---|
| `DPI_AUTH_TOKEN` | （可选）client端 bearer session token——跳过 ed25519 challenge-response。正常情况用 `<user>@<url>`语法自动签 |
| `DPI_HUB_URL` | executor子进程的 hub URL（运行时注入） |
| `DPI_CONNECT_ID` | executor子进程的 connect id（运行时注入） |
| `DPI_CWD` | executor子进程的 cwd（运行时注入） |

`DPI_AUTH_TOKEN` 在 `cli-runner.ts:194` / `client-extension.ts:17` / `executor/env.ts:13`读取。`DPI_HUB_URL` / `DPI_CONNECT_ID` / `DPI_CWD` 在 `executor/env.ts:readExecutorEnv`读取（缺一抛 `Missing required env vars: ...`）。

## 相关

- [Agent工具参考](./tools) — agent视角
- [Slash命令参考](./slash-commands) — TUI视角
