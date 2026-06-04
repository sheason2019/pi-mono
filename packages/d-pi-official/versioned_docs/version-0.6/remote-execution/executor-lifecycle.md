---
title: Executor 生命周期
sidebar_position: 2
---

# Executor 生命周期

一句话：executor 跟 TUI 一起由 `d-pi connect` 拉起和回收。

## 启动

跑 `d-pi connect` 时，connect 进程会同时拉起：

1. pi TUI 子进程（`pi connect 模式`）
2. d-pi executor 子进程（`d-pi _executor-child`，持有 native tools）

executor 启动后向 hub 注册（`POST /_hub/executor/register`），然后建立 SSE 长连接接收工具调用。

## 运行中

executor 收到工具调用时：

1. 在 client 机器的 cwd 上跑 native tool
2. 把结果 POST 回 hub（`POST /_hub/executor/results`）
3. hub 路由回 agent

executor 跟 hub 走长连接，AbortSignal 透传，agent Ctrl+C 取消会立即终止 executor 里的工具。

## 退出

当 TUI 退出或 hub 死掉时，connect 给 executor 发 SIGTERM：

- executor 的 SIGTERM handler 立即 `process.exit(0)`（不等 SSE drain）
- 终端状态（光标、kitty 协议、bracketed paste）被父进程 pop 干净
- hub 上 `connect_id` 绑定自动清理

## 进程关系

```
shell                                                           
  └─ d-pi connect (parent)                                       
       ├─ pi TUI (子进程)                                        
       └─ d-pi executor (子进程)                                 
            └─ SSE 连接到 hub
```

## 相关

- [connect 命令](../getting-started/connect)
- [第一次会话](../getting-started/first-session) — 跑通 executor 链路

## 注意事项

- executor 跑在 **client 机器的 cwd**，不是 hub 机器的 cwd
- 在 ssh / tmux 里跑 connect，executor 继承 ssh session 的 cwd
- executor 的 native tool 集跟 agent worker 的 native tool 集**完全一致**——
  `remote_*` 工具只是工具名前缀加 `remote_`

