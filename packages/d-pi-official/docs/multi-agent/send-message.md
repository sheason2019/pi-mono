---
title: send_message
sidebar_position: 3
---

# send_message

一句话：把消息派给指定 agent（异步，不等回复）。

## 用法

工具名 `send_message`。Agent 用来给子 agent 或并行 agent 派活。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agent_id` | string | 是 | 目标 agent id 或 name |
| `message` | string | 是 | 消息内容 |

## 返回值

```json
{
  "delivered": true,
  "agent_id": "<resolved-id>"
}
```

## 示例

**场景**：root agent 给刚创建的 `researcher` 派活。

```bash
send_message(agent_id="researcher", message="研究 React Server Components 的核心机制")
```

**预期返回**：

```json
{ "delivered": true, "agent_id": "a1b2-..." }
```

目标 agent 会在它的下一轮 LLM 推理中处理这条消息。

## 相关

- [create_agent](./create-agent) — 创建目标 agent
- [agent_network](./agent-network) — 查 agent id

## 注意事项

- **异步语义**：消息成功派发即返回，**不等**目标 agent 完成
- 想等目标 agent 完成再继续：先用 `agent_network` 轮询，或在 message 里写「完成后请通知我」
- `agent_id` 支持用 name 自动解析；如果有重名会失败
