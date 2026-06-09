---
title: 启动 hub
sidebar_position: 3
---

# d-pi serve

一句话：启动 d-pi hub（中心节点），在后台跑直到 Ctrl+C杀掉。

##用法

在已 `d-pi init`的目录跑：

```bash
d-pi serve
```

默认监听 `http://localhost:39090`。自定义端口：

```bash
d-pi serve --port39100
```

指定默认模型：

```bash
d-pi serve --model claude-sonnet-4-20250514
```

##预期输出

```
[d-pi hub] Workspace: /Users/me/my-project
[d-pi hub] Restoring agent "root" from root/
[d-pi hub] Listening on port39090
[d-pi hub] Connect with: d-pi connect <local-user@http://localhost:39090>
```

##参数

|标志 |说明 |默认 |
|---|---|---|
| `--port` |监听端口 | `39090` |
| `--model` | agent默认 model规格 | 从 settings读 |

## 相关

- [连接 client](./connect)
- [用户与认证 → 用户白名单](../auth/allow-user)
- [用户与认证 → DPI_AUTH_TOKEN](../auth/dpi-auth-token)

##注意事项

- hub启动后持久化：`agents/<name>/agent.json`（每个 agent 的 wiring，含 roles/model/sessionId）+ `.dpi-sessions/<name>/`（session 历史）。下次启动自动恢复
- 当前 hub默认开启 auth，client必须走 ed25519 challenge-response 或带有效 `DPI_AUTH_TOKEN` 才能连上。详见 [认证概览](../auth/overview)
-没有 `--no-auth` flag——`AuthSessionManager` 在 `Hub`构造时无条件实例化
