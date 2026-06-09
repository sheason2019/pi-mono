---
title: /agents
sidebar_position: 4
---

# /agents

一句话：在 client TUI里以 select选择面板查看 agent树并切换。

##用法

在 `d-pi connect` TUI里输入：

```
/agents
```

TUI弹出 **select选择面板**（上下键导航，Enter选中 /取消），以树形展示 hub 上的 agent网络：

```
Agent network (4)
 root [ready] (r-1) ← current
 researcher [busy] (r-2)
 writer [ready] (r-3)
 writer-sub [starting] (r-4)
```

选中一个 agent按 Enter → TUI切换到该 agent会话上下文（respawn机制，等价于 `connect <id>`）。

## AgentStatus状态值

每个 agent的状态取值是 `AgentStatus`枚举：

|值 |含义 |
|---|---|
| `starting` | 子进程刚拉起，还没收到首个 LLM ready信号 |
| `ready` |已就绪，等待输入 |
| `busy` |正在跑 LLM推理或工具调用 |
| `error` | worker进程异常退出或初始化失败 |
| `destroyed` |已销毁（`destroy_agent` 后或 worker自然退出） |

注：**没有** `running` / `stopped`状态值（这是历史误标，已校准）。

##行为

-命令在 client端发 HTTP 请求到 hub（`GET /_hub/network`）
- hub 返回当前拓扑快照
- client渲染成 select选择面板，支持 Enter选中、Esc取消
-切换后 TUI prompt 区显示当前目标 agent（respawn走 `AGENT_SWITCH_FILE`机制，参 [meta-connect](../multi-agent/meta-connect)）

## 相关

- [Agent Network目录约定 →概览](../agent-network/overview) ——怎么设计 agent-network目录让 `/agents` 有东西可看
- [connect &lt;id&gt;](../multi-agent/meta-connect) —命令行等价
- [agent_network工具](../multi-agent/agent-network) — agent用

##注意事项

- 命令在 client端执行，需要 client配 `DPI_AUTH_TOKEN`跟 hub 的 bearer token 对齐（hub auth开启时；hub auth关闭时不需）
- select面板显示的是 hub当前状态快照，agent状态可能在 select期间已变化
