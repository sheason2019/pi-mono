---
title: subscribe_source
sidebar_position: 3
---

# subscribe_source

一句话：把指定 source 的 stdout 流订阅到当前 agent 的上下文。

## 用法

工具名 `subscribe_source`。Agent 调一次即可，hub 持续把新数据推过来。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source_name` | string | 是 | source 名字（不是 id） |

## 返回值

立即返回 `{"subscribed": true}`，后续推送走 hub 异步通知。

## 示例

**场景**：监控日志。

```bash
subscribe_source(source_name="app-logs")
```

**预期返回**：

```json
{ "subscribed": true }
```

随后 agent 会在 LLM 决策时看到 source 新输出的内容（作为用户消息的 `customType: "d-pi-source"` 流）。

## 相关

- [create_source](./create-source) — 先有 source
- [unsubscribe_source](./unsubscribe-source) — 取消订阅

## 注意事项

- 一个 source 可被多个 agent 订阅，互不影响
- agent 退出或被 destroy 时，订阅自动清理

