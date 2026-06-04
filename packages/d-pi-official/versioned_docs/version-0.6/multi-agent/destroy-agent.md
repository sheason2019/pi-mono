---
title: destroy_agent
sidebar_position: 5
---

# destroy_agent

一句话：销毁一个 agent 及其所有子 agent（递归）。

## 用法

工具名 `destroy_agent`。Agent 收尾时调用。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agent_id` | string | 是 | 目标 agent id 或 name |

## 返回值

```json
{
  "destroyed": ["<id-1>", "<id-2>", "<id-3>"]
}
```

返回的 `destroyed` 列表包含被销毁的 agent 及其所有递归子 agent。

## 示例

**场景**：任务完成，root agent 清理临时子 agent。

```bash
destroy_agent(agent_id="researcher")
```

**预期返回**：

```json
{ "destroyed": ["r-2", "r-3"] }
```

（假设 `researcher` 下面还有子 agent `r-3`，一起被销毁）

## 相关

- [create_agent](./create-agent) — 对面
- [agent_network](./agent-network) — 销毁前先确认

## 注意事项

- 销毁是**递归**的：传一个父 agent 会把它所有子 agent 一起干掉
- 销毁 root agent 不会关 hub，只是让 root 进入 `destroyed` 状态
- 已经在 running 的子 agent 会先收到 graceful shutdown 信号
