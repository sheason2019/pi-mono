---
title: destroy_agent
sidebar_position: 5
---

# destroy_agent

一句话：销毁一个 agent及其所有子 agent（递归）。

## 用法

工具名 `destroy_agent`。Agent收尾时调用。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `agent_id` | string |是 |目标 agent id 或 name |

##返回值

工具返回**纯 text**：

```
Agent "researcher" destroyed
```

## 示例

**场景**：任务完成，root agent清理临时子 agent。

```bash
destroy_agent(agent_id="researcher")
```

**预期返回**：

```
Agent "researcher" destroyed
```

（递归：假设 `researcher`下面还有子 agent `r-3`，一起被销毁。Hub 的 `AgentRegistry.unregister()`实际走深度优先，descendants一起干掉。）

## 相关

- [create_agent](./create-agent) —对面
- [agent_network](./agent-network) —销毁前先确认

##注意事项

-销毁是**递归**的：传一个父 agent会把它所有子 agent一起干掉（实现：`AgentRegistry.unregister`走 getDescendants + unregister cascade）
-销毁 root agent不会关 hub，只是让 root 进入 `destroyed`状态
-已经在 running 的子 agent会先收到 graceful shutdown 信号
-工具 description写 "must have no children" 是 lint风格的 hint；hub实际走递归路径，不强制无 children
-被销毁 agent 如果是某个 source的 creator，那个 source 需要先 unsubscribe +destroy
