---
title: subscribe_source
sidebar_position: 3
---

# subscribe_source

一句话：把指定 source 的 stdout流订阅到当前 agent 的上下文。

##用法

工具名 `subscribe_source`。Agent调一次即可，hub持续把新数据推过来。

> 创建 source 时创建者 agent会被 **auto-subscribe**，所以很多场景不需要显式 subscribe。显式 subscribe 用于给其他 agent 加订阅的场景。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `source_name` |string |是 | source名字（不是 id，source 用 name标识） |

##返回值

工具返回纯 text：

```
Subscribed to source "app-logs"
```

## Source 输出如何到达 agent

Source进程的 stdout 每行 JSONRPC notification 经 hub严格 parse后，会作为 `customType: "d-pi-message"` 的 custom message 进入 agent context。
**routing决策由 source 在 notification 的 `params` 里声明**，hub parse + coerce 后透传：

|字段 |可选值 |默认 |含义 |
|---|---|---|---|
| `params.deliverAs` | `"steer"` / `"followUp"` / `"prompt"` | `"followUp"` | routing模式（参 [overview → Per-event路由](./overview)） |
| `params.drainMode` | `"all"` / `"one-at-a-time"` | `"all"` | queued消息 batching模式 |

举例：

```json
{"jsonrpc":"2.0","method":"alert","params":{"text":"high CPU","deliverAs":"steer","drainMode":"one-at-a-time"}}
```

这条 notification到达 agent 时:

- `deliverAs: "steer"` → extension映射 `{deliverAs: "steer"}`，中断当前 turn立即注入
- `drainMode: "one-at-a-time"` → 每条 queued消息独立 turn 处理（待 upstream coding-agent暴露对应 sendMessage slot，目前 extension收到后只 stderr log透传）

## 示例

**场景**：监控日志。

```bash
subscribe_source(source_name="app-logs")
```

**预期返回**：

```
Subscribed to source "app-logs"
```

随后 agent会在 LLM决策时看到 source 新输出的内容（作为 `customType: "d-pi-message"` 的 custom message，跟 connect消息同 customType，渲染层按 meta source区分）。

## 相关

- [create_source](./create-source) — 先有 source
- [unsubscribe_source](./unsubscribe-source) —取消订阅
- [overview → Per-event路由](./overview) — deliverAs + drainMode完整语义

##注意事项

- 一个 source 可被多个 agent订阅，互不影响
- agent退出或被 destroy 时，订阅自动清理（`SourceManager.removeAgentSubscriptions`）
- routing决策所有权在 SourceManager（hub侧），不在 extension — extension 只是1:1 mapper
