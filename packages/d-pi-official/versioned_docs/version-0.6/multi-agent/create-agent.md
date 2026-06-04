---
title: create_agent
sidebar_position: 2
---

# create_agent

一句话：在当前 agent 下创建一个子 agent，返回子 agent 的 id。

## 用法

工具名 `create_agent`。Agent 在需要把任务委派给子 agent 时调用。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 子 agent 名字，hub 内唯一 |
| `prompt` | string | 否 | 子 agent 的初始 system prompt |
| `parent_id` | string | 否 | 父 agent id；默认调用方自己 |

## 返回值

```json
{
  "id": "uuid-xxx",
  "name": "researcher",
  "parent_id": "uuid-yyy"
}
```

## 示例

**场景**：root agent 创建一个负责查文档的子 agent。

```bash
# Agent 在 LLM 决策时输出
create_agent(name="researcher", prompt="你是文档查询专家")
```

**预期返回**：

```json
{ "id": "a1b2-...", "name": "researcher", "parent_id": "<caller-id>" }
```

随后可用 `send_message(agent_id="researcher", message="...")` 派活。

## 相关

- [agent_network](./agent-network) — 查子 agent 是否已存在
- [send_message](./send-message) — 派活给子 agent
- [destroy_agent](./destroy-agent) — 收尾时清理

## 注意事项

- 子 agent 创建后会进入 `starting` 状态，等其首个 LLM 调用完成才进入 `running`
- `name` 一旦指定不可改；如需重命名，destroy + create
