---
title: Slash 命令
sidebar_position: 3
---

# Slash 命令参考

一句话：在 `d-pi connect` TUI 里以 `/` 开头的命令。

## d-pi 注册的命令

| 命令 | 用途 | 文档 |
|---|---|---|
| `/sources` | 图形化查看 hub 上所有 source | [Sources → /sources](../sources/slash-sources) |
| `/agents` | 图形化查看 agent 树并切换 | [Remote Execution → /agents](../remote-execution/slash-agents)（实现） —语义见 [Multi Agent → group_architecture](../multi-agent/group-architecture) |

## pi 内置命令（透传）

pi coding-agent 自带的 slash 命令在 d-pi TUI 里同样可用，常用的：

| 命令 | 用途 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 清空当前会话 |
| `/compact` | 压缩上下文 |
| `/model` | 切换模型 |
| `/exit` / `/quit` | 退出 TUI |

完整列表见 [上游 pi 文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/usage.md)。

## 自定义扩展命令

如果你安装了第三方 d-pi 扩展，它可能注册额外的 `/` 命令。
用 `/commands` 查看当前 TUI 加载的所有命令。

## 相关

- [CLI 命令](./cli)
- [Agent 工具](./tools)

