---
title: CLI 命令
sidebar_position: 1
---

# CLI 命令参考

一句话：所有 `d-pi <command>` 的清单。

## 顶层命令

| 命令 | 用途 | 文档 |
|---|---|---|
| `d-pi init` | 在当前目录创建 d-pi workspace | [快速上手 → init](../getting-started/init) |
| `d-pi serve` | 启动 hub | [快速上手 → serve](../getting-started/serve) |
| `d-pi connect` | 连到 hub 进入 TUI | [快速上手 → connect](../getting-started/connect) |

## 用户管理

### `d-pi users`

| 子命令 | 说明 |
|---|---|
| `d-pi users create <name>` | 创建本地用户 |
| `d-pi users list` | 列出 |
| `d-pi users update <name>` | 更新 |
| `d-pi users delete <name>` | 删除 |

详见 [用户管理](../auth/users)。

### `d-pi allow-user`

| 子命令 | 说明 |
|---|---|
| `d-pi allow-user add <name>` | 加入白名单 |
| `d-pi allow-user list` | 列出 |
| `d-pi allow-user update <name>` | 更新 |
| `d-pi allow-user remove <name>` | 移除 |

详见 [允许的用户](../auth/allow-user)。

## 全局标志

| 标志 | 适用 | 说明 |
|---|---|---|
| `--help`, `-h` | 所有 | 显示帮助 |
| `--version`, `-V` | 所有 | 显示版本 |

## 环境变量

| 变量 | 用途 |
|---|---|
| `DPI_AUTH_TOKEN` | client 端必带的 bearer token |
| `DPI_HUB_URL` | executor 子进程的 hub URL（运行时注入） |
| `DPI_CONNECT_ID` | executor 子进程的 connect id（运行时注入） |
| `DPI_CWD` | executor 子进程的 cwd（运行时注入） |

## 相关

- [Agent 工具参考](./tools) — agent 视角
- [Slash 命令参考](./slash-commands) — TUI 视角

