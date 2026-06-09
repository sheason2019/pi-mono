---
title: 连接 hub
sidebar_position: 4
---

# d-pi connect

一句话：从你的终端连到一个 d-pi hub，进入 TUI操作 agent。

## 用法

**主路径**:用 `<user>@<url>`语法（user是你在 client机器的 local user name，url是 hub的 HTTP URL）。CLI 会自动走 ed25519 challenge-response拿 session token，**不需要**预先 export `DPI_AUTH_TOKEN`:

```bash
d-pi connect alice@http://localhost:39090
```

或显式 `--url` + env token:

```bash
DPI_AUTH_TOKEN=<token> d-pi connect --url http://hub.example.com:39090
```

指定默认 agent（省略则用 hub 的 root agent）:

```bash
d-pi connect alice@http://hub:39090 --agent researcher
```

##参数

|标志 |说明 |默认 |
|---|---|---|
| `<user>@<url>` | positional: local user name + hub URL（**主路径**） | — |
| `--url` | hub URL（fallback，仅在没 positional 时使用） | `http://localhost:39090` |
| `--agent` |启动后进入的 agent id 或 name | hub 的 root |

##行为

1.跟 hub 建立 HTTP通道
 - 主路径: client读 `~/.d-pi/users/<name>.json` 的 ed25519 privateKey，POST challenge → hub返回 challenge → client签名 → POST session →拿 token →后面带 Bearer
 - env path: 直接用 `DPI_AUTH_TOKEN` env（无 challenge-response）
2.拉起两个子进程：pi TUI（`pi connect模式`）+ d-pi executor（跑本机 native工具）
3. 进入 pi TUI界面，可以开始跟 agent 对话

## DPI_AUTH_TOKEN 环境变量

**正常情况下不需要设**——主路径 `<user>@<url>` 自动签 challenge拿 token。 `DPI_AUTH_TOKEN` 在以下场景才用：

-跨机器想让 client 连 hub ——机器 A跑 `d-pi connect alice@hub`，机器 B 想直接复用这个 token
-写脚本测试
- CI 环境（无法跑 interactive challenge-response）

`DPI_AUTH_TOKEN` 从 `process.env`读（`cli-runner.ts:194` / `client-extension.ts:17` / `executor/env.ts:13`）。Hub 重启后旧 token失效，必须重走 challenge-response。

##退出

- 在 TUI 里 `Ctrl+C`退出
-退出时 connect 会自动给 executor 发 SIGTERM 并清理 hub 上的绑定
-你的 terminal状态（光标显示、bracketed paste、kitty协议）会被正确还原

## 相关

- [第一次会话](./first-session)
- [远程执行 → executor生命周期](../remote-execution/executor-lifecycle)
- [用户与认证 → DPI_AUTH_TOKEN](../auth/dpi-auth-token)

##注意事项

- connect 会同时拉起 executor 子进程；如果你的 hub启用了 remote execution，executor在你机器上跑 native工具
- 在 ssh / tmux 里跑 connect时，executor会从 ssh session继承 cwd
-切到子 agent 用 `connect <id>`（[meta-connect](../multi-agent/meta-connect)）——实际是 TUI respawn机制，**不**是 meta消息路由
