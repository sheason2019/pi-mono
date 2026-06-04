---
title: 概览
sidebar_position: 1
---

# 数据源（Sources）

Sources 是把外部命令的输出流注入到 agent 上下文的机制。
你可以注册一个 shell 命令（`tail -f logs`、`ps aux`、自定义脚本），
agent 订阅后，命令的 stdout 会被持续地推送到 agent 上下文里。

## 工具一览

| 工具 | 用途 |
|---|---|
| [create_source](./create-source) | 注册一个 source（命令 + 名字） |
| [subscribe_source](./subscribe-source) | 订阅 source 推送（agent 收到） |
| [unsubscribe_source](./unsubscribe-source) | 取消订阅 |
| [list_sources](./list-sources) | 列出 hub 上所有 source |
| [/sources](./slash-sources) | client TUI 命令，图形化查看 |

## 端到端例子

把 `tail -f /var/log/app.log` 注册成 source 并订阅：

```
1. create_source(name="app-logs", command="tail -f /var/log/app.log")
   → source 进入 running 状态

2. subscribe_source(source_name="app-logs")
   → agent 上下文开始收到新 log 行

3. agent 处理 log，看到 ERROR 级别时自动 create_agent 派子 agent 分析

4. unsubscribe_source(source_name="app-logs")
5. destroy_source 收尾（暂未提供）
```

## 相关

- [多 Agent 编排 → 概览](../multi-agent/overview) — agent 拿到 log 后派活的模式
- [/sources 命令](./slash-sources) — client 端查看

