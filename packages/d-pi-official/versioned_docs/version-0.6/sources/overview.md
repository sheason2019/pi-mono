# Sources

> d-pi source 是 long-running command, 通过 JSON-RPC 2.0 protocol 跟 hub 通信。

Source 是 d-pi 的 external data push 通道, 跟 Lark 消息 / GitHub webhook / 自定义 cron 是平行的: 任何持续输出 JSON-RPC 2.0 notification 的 process 都能 register 成 source, push 给订阅的 agent。

## 协议

- **协议**: JSON-RPC 2.0
- **传输**: source 命令 stdout, 一行一个 notification
- **方向**: 单向 push (source → agent, 跟 PR #25 重构后一致)
- **格式**: 必须有 `jsonrpc: "2.0"`, `method: "events.emit"`, `params.type`; 可选 `params.id` (event id for ack/dedup), `params.data` (任意 payload), `params.mode` (routing 模式)
- **错误处理**: request/response/invalid 静默 drop, 不报 stderr warning (跟 "只挑有价值输出" 原则一致)

> 详见 [Protocol → JSON-RPC 2.0 协议](../reference/protocol) (待 PR 文档补) 或直接看 source: `packages/d-pi/src/hub/source-validator.ts`

## Per-event 路由 (`params.mode`)

Source 在每条 notification 的 `params` 里声明一个 routing 字段, hub parse + coerce 后透传到 agent。 词汇跟 TUI 的 Enter / Ctrl+Enter 1:1 对齐, source 作者不用懂 internal queue mechanics。

```json
{"jsonrpc":"2.0","method":"alert","params":{"text":"high CPU","mode":"steer"}}
```

### `params.mode` (必填? 不; 默认 `"next"`)

| 值 | 行为 |
|---|---|
| `"steer"` | 中断当前 turn, 立即注入 (紧急事件, 如 alert / 严重错误) |
| `"next"` | 默认. queue 到下个 turn 起头注入 (TUI 按 Enter 等价) |

未知值 coerce 到 `"next"`, 写错不会让 source 行为退化。

> 路由决策所有权在 `SourceManager` (parse + coerce + 透传), extension 只做 1:1 mapping:
> `steer → {deliverAs: "steer"}` (中断 turn) / `next → {triggerTurn: true}` (起新 turn)。

## 端到端例子

把一条持续输出 JSONRPC notification 的命令注册成 source:

```bash
# 1. 注册 source (假设命令持续 emit JSONRPC lines)
create_source(
  name="app-logs",
  command="sh",
  args=["-c", "while true; do echo \'{"jsonrpc":"2.0","method":"log","params":{"text":"ERROR foo","mode":"next"}}\'; sleep1; done"]
)
# → "Source \"app-logs\" created and running. You have been automatically subscribed to this source."

# 2. (可选) 显式订阅 — 创建时已 auto-subscribe 创建者 agent
subscribe_source(source_name="app-logs")
# → "Subscribed to source \"app-logs\""

# 3. agent 收到 source 推送:
# d-pi-message (customType="d-pi-message") 进入 context,
# params.mode 决定 routing (steer 中断 / next 起新 turn)

# 4. 取消订阅
unsubscribe_source(source_name="app-logs")
# → "Unsubscribed to source \"app-logs\""

# 5. 销毁 source (所有 agent 必须先 unsubscribe)
destroy_source(name="app-logs")
```

## SourceStatus 状态

`SourceInfo.status` 是 4 值 enum, 跟 PR #25 supervisor 一致:

- `running` — 正常 emit notification
- `stopped` — 上次 exit, supervisor 在等 restart 窗口
- `error` — process error (spawn / IO 异常), supervisor 在等 restart
- `failed` — 超过 maxRestartAttempts, 放弃 supervisor, 需要 operator 介入 (destroy + recreate, 或修 command)

## Source destroy 前置

destroy_source 之前, 所有订阅该 source 的 agent 必须先 unsubscribe, 否则抛错:

> Cannot destroy source "X": N subscriber(s) still active (agent1, agent2, ...). Unsubscribe all agents first.
