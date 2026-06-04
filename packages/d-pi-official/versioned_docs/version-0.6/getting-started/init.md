---
title: 初始化 workspace
sidebar_position: 2
---

# d-pi init

一句话：在当前目录创建一个 d-pi workspace。

## 用法

在你想作为 d-pi 根的目录跑：

```bash
cd ~/my-project
d-pi init
```

预期输出：

```
[d-pi] Workspace initialized in current directory
[d-pi]   .dpi/config.json        — workspace configuration
[d-pi]   AGENTS.md               — shared context for all agents
[d-pi]   APPEND_SYSTEM.md        — shared system prompt for all agents
[d-pi]   agents/root/            — root agent working directory
[d-pi]   agents/root/AGENTS.md   — root agent specific context
[d-pi]   agents/root/.pi/APPEND_SYSTEM.md — root agent system prompt
[d-pi] Run 'd-pi serve' to start the hub.
```

## 它做了什么

在当前目录生成：

- `.dpi/config.json`：workspace 配置（agent 树结构、默认模型等）
- `AGENTS.md`：所有 agent 共享的上下文
- `APPEND_SYSTEM.md`：所有 agent 共享的 system prompt 补充
- `agents/<name>/`：每个 agent 的工作目录、专属 AGENTS.md、`.pi/APPEND_SYSTEM.md`

## 相关

- [启动 hub](./serve)
- [连接 client](./connect)

## 注意事项

- 必须在空目录（或仅含已有 workspace 的目录）跑，否则可能覆盖
- `init` 是幂等的：重复跑不会破坏已有 workspace
