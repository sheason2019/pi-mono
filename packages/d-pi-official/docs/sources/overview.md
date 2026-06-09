---
title: 概览
sidebar_position: 1
---

# 数据源（Sources）

Sources 是把外部进程的 stdout 流接入到 agent上下文的机制。
你注册一个 shell 命令（`tail -f logs` / 自定义 watcher脚本 / Node进程），agent订阅后，
进程 stdout 按 [JSONRPC2.0 notification](https://www.jsonrpc.org/specification)格式逐行推送，hub验证后转发给订阅者。

##工具一览

|工具 |用途 |
|---|---|
| [create_source](./create-source) | 注册一个 source（命令 +名字） |
| [subscribe_source](./subscribe-source) |订阅 source推送（agent收到） |
| [unsubscribe_source](./unsubscribe-source) |取消订阅 |
| [destroy_source](../reference/tools) |销毁 source（所有 agent取消订阅后才能销毁） |
| [list_sources](./list-sources) |列出 hub 上所有 source |
| [/sources](./slash-sources) | client TUI 命令，select面板查看 |

## stdout契约：JSONRPC2.0 notification

Source进程的 stdout **每行一条 JSONRPC2.0 notification**，hub 用严格 validator逐行 parse：

```json
{"jsonrpc":"2.0","method":"log","params":{"text":"ERROR foo","level":"error"}}
```

规则：

- **notification** (`method`存在, 无 `id`, 无 `result`/`error`):转发给订阅 agent
- **request** (`method` + `id` 同时存在):静默丢弃 — source 是 push service，不接受请求
- **response** (有 `result` 或 `error`):静默丢弃
- **invalid** (JSON解析失败 /缺 `jsonrpc: "2.0"` /缺 `method`):静默丢弃 — 不挂 source，不写 stderr警告

任何不是 JSONRPC notification 的 stdout 行都会被 hub静默吞掉。如果你的 source 输出原始日志（`tail -f` / `journalctl -f`），
需要在外层包装一层把每行 log 转成 JSONRPC notification（最简实现: `tail -f /var/log/app.log | while read line; do echo "{\"jsonrpc\":\"2.0\",\"method\":\"log\",\"params\":{\"text\":$(printf '%s' "$line" | jq -Rs .)}}"; done`）。

## Per-event路由（deliverAs + drainMode）

Source可以在每条 notification 的 `params` 里声明两个 routing字段，hub parse + coerce 后透传到 agent：

```json
{"jsonrpc":"2.0","method":"alert","params":{"text":"high CPU","deliverAs":"steer","drainMode":"one-at-a-time"}}
```

### `params.deliverAs`（必填？不；默认 `"followUp"`）

| 值 |行为 |
|---|---|
| `"steer"` | 中断当前 turn，立即注入（紧急事件用，如 alert /严重错误） |
| `"followUp"` | 默认。queue 到当前 turn结束之后处理（如 lark消息 / 健康报告） |
| `"prompt"` |跟 followUp同一 routing，但 source显式标记为"需要新 turn"的事件（如人工输入 /任务触发） |

未知值 coerce 到 `"followUp"`，所以写错不会让 source行为退化。

### `params.drainMode`（默认 `"all"`）

| 值 |行为 |
|---|---|
| `"all"` | 默认。把一批 queued消息合并成单个 context window 处理（跟 PR #25之前的 batch行为一致） |
| `"one-at-a-time"` | 每条 queued消息独立 turn 处理（适合交互事件，每条事件都值得独立回应） |

未知值 coerce 到 `"all"`。

>路由决策所有权在 `SourceManager`（这里负责 parse + coerce +透传），extension 只做1:1 mapping:
> `steer → {deliverAs:"steer"}` / `followUp → {deliverAs:"followUp"}` / `prompt → {triggerTurn:true}`。

##端到端例子

把一条持续输出 JSONRPC notification 的命令注册成 source：

```bash
#1. 注册 source (假设命令持续 emit JSONRPC lines)
create_source(
 name="app-logs",
 command="sh",
 args=["-c", "while true; do echo '{\"jsonrpc\":\"2.0\",\"method\":\"log\",\"params\":{\"text\":\"ERROR foo\"}}'; sleep1; done"]
)
# → "Source \"app-logs\" created and running. You have been automatically subscribed to this source."

#2. (可选)显式订阅 — 创建时已 auto-subscribe 创建者 agent
subscribe_source(source_name="app-logs")
# → "Subscribed to source \"app-logs\""

#3. agent收到 source推送:
# d-pi-message (customType="d-pi-message") 进入 context,
# params.deliverAs决定 routing (steer / followUp / prompt),
# params.drainMode决定 batching (all / one-at-a-time)

#4.取消订阅
unsubscribe_source(source_name="app-logs")
# → "Unsubscribed from source \"app-logs\""

#5.销毁 source (所有 agent 必须先 unsubscribe)
destroy_source(name="app-logs")
# → "Source \"app-logs\" destroyed"
```

## Source lifecycle（4 个状态）

`list_sources` 返回的 `status`字段有4 个枚举值：

| status |含义 |
|---|---|
| `running` |进程跑着，正常推送 |
| `stopped` |进程退出，supervisor等待 exponential backoff 重启 |
| `error` | spawn /进程错误，supervisor等待重试 |
| `failed` | 重试超过 `maxRestartAttempts`（默认5）后放弃，需人工介入 |

Supervisor 用 exponential backoff（默认10s →60s）重启任何非 `destroyed`退出，包括 code0
（因为 `tail -f` 类长进程不应有"正常完成"概念）。

## 相关

- [多 Agent编排 →概览](../multi-agent/overview) — agent拿到 source 后派活的模式
- [/sources 命令](./slash-sources) — client端 select面板查看
- [create_source 参数细节](./create-source)
- [subscribe_source 输出路由](./subscribe-source)
