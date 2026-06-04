---
title: /agents
sidebar_position: 4
---

# /agents

一句话：在 client TUI 里以面板形式查看 agent 树并切换。

## 用法

在 `d-pi connect` TUI 里输入：

```
/agents
```

TUI 弹出 panel，以树形展示 hub 上的 agent 网络：

```
Agent network (4)
  root [running] (r-1) ← current
    researcher [running] (r-2)
    writer [stopped] (r-3)
      writer-sub [running] (r-4)
```

选中一个 agent 按 Enter → TUI 切换到该 agent 上下文（等价于 `connect <id>`）。

## 行为

- 命令在 client 端发 HTTP 请求到 hub（`GET /_hub/network`）
- hub 返回当前拓扑快照
- client 渲染成树形 panel，支持 Enter 选中、Esc 退出
- 切换后 TUI prompt 区显示当前目标 agent

## 相关

- [connect &lt;id&gt;](../multi-agent/meta-connect) — 命令行等价
- [agent_network 工具](../multi-agent/agent-network) — agent 用

## 注意事项

- 命令在 client 端执行，需要 `DPI_AUTH_TOKEN` 配对
- panel 是快照，agent 状态可能在 select 期间已变化

