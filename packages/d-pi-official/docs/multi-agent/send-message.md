---
title: send_message
sidebar_position: 3
---

# send_message

一句话：把消息派给指定 agent（异步，不等回复）。

## 用法

工具名 `send_message`。Agent用来给子 agent或并行 agent派活。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `agent_id` | string |是 |目标 agent id 或 name |
| `message` | string |是 |消息内容 |

##返回值

工具返回**纯 text**：

```
Message sent to agent researcher. Result:{"ok":true}
```

`details.ok`字段是结构化的 success flag。

## 示例

**场景**：root agent给刚创建的 `researcher`派活。

```bash
send_message(agent_id="researcher", message="研究 React Server Components 的核心机制")
```

**预期返回**：

```
Message sent to agent researcher. Result:{"ok":true}
```

目标 agent会在它的下一轮 LLM推理中处理这条消息。

## 相关

- [create_agent](./create-agent) —创建目标 agent
- [group_architecture](./group-architecture) —查 agent id

##注意事项

- **异步语义**：消息成功派发即返回，**不等**目标 agent完成
-想等目标 agent完成再继续：先用 `group_architecture`轮询，或在 message里写「完成后请通知我」
- `agent_id` 支持用 name自动解析；如果有重名会失败
- **不**共享工具调用历史 ——目标 agent不会自动看到源 agent 的工具输出历史；源 agent要把发现摘要**显式 send_message 转写**过去
