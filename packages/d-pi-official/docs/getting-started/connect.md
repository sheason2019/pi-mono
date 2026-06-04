---
title: 连接 hub
sidebar_position: 4
---

# d-pi connect

一句话：从你的终端连到一个 d-pi hub，进入 TUI 操作 agent。

## 用法

默认连本地 hub：

```bash
d-pi connect
```

连远程 hub：

```bash
d-pi connect --url http://192.168.1.10:39090
```

指定默认 agent（省略则用 hub 上的 root agent）：

```bash
d-pi connect --agent researcher
```

带 auth token（hub 默认开 auth）：

```bash
DPI_AUTH_TOKEN=<token> d-pi connect --url http://hub.example.com:39090
```

## 参数

| 标志 | 说明 | 默认 |
|---|---|---|
| `--url` | hub URL | `http://localhost:39090` |
| `--agent` | 启动后进入的 agent id 或 name | hub 的 root |

## 行为

1. 跟 hub 建立 HTTP 通道
2. 拉起两个子进程：pi TUI（`pi` connect 模式）+ d-pi executor（跑本机 native 工具）
3. 进入 pi TUI 界面，可以开始跟 agent 对话

## 退出

- 在 TUI 里 `Ctrl+C` 退出
- 退出时 connect 会自动给 executor 发 SIGTERM 并清理 hub 上的绑定
- 你的 terminal 状态（光标显示、bracketed paste、kitty 协议）会被正确还原

## 相关

- [第一次会话](./first-session)
- [远程执行 → executor 生命周期](../remote-execution/executor-lifecycle)
- [用户与认证 → DPI_AUTH_TOKEN](../auth/dpi-auth-token)

## 注意事项

- connect 会同时拉起 executor 子进程；如果你的 hub 启用了 remote execution，executor 在你机器上跑 native 工具
- 在 ssh / tmux 里跑 connect 时，executor 会从 ssh session 继承 cwd
