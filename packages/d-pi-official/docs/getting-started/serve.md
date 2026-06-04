---
title: 启动 hub
sidebar_position: 3
---

# d-pi serve

一句话：启动 d-pi hub（中心节点），在后台跑直到 Ctrl+C 杀掉。

## 用法

在已 `d-pi init` 的目录跑：

```bash
d-pi serve
```

默认监听 `http://localhost:39090`。自定义端口：

```bash
d-pi serve --port 39100
```

指定默认模型：

```bash
d-pi serve --model claude-sonnet-4-20250514
```

## 预期输出

```
[d-pi hub] Workspace: /Users/me/my-project
[d-pi hub] Auth: enabled (use `d-pi allow-user add` to grant access)
[d-pi hub] Listening on http://localhost:39090
[d-pi hub] Hub started. Press Ctrl+C to stop.
```

## 参数

| 标志 | 说明 | 默认 |
|---|---|---|
| `--port` | 监听端口 | `39090` |
| `--model` | agent 默认 model 规格 | 从 settings 读 |

## 相关

- [连接 client](./connect)
- [用户与认证 → 用户白名单](../auth/allow-user)
- [用户与认证 → DPI_AUTH_TOKEN](../auth/dpi-auth-token)

## 注意事项

- hub 启动后会在 `.dpi/hub-state.json` 持久化拓扑和 agent 状态；下次启动自动恢复
- 当前 hub 默认开启 auth，client 必须带正确的 `DPI_AUTH_TOKEN` 才能连上
