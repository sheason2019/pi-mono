---
title: group_architecture
sidebar_position: 4
---

# group_architecture

一句话：查整个 agent 树，返回所有 agent 的状态、父子关系。

## 用法

工具名 `group_architecture`。无参数，立即返回当前 hub 上的拓扑快照。

## 参数

无。

## 返回值

```json
{
  "rootId": "<root-id>",
  "agents": [
    {
      "id": "<id-1>", "name": "root", "status": "running",
      "parent_id": null, "children": ["<id-2>"]
    },
    {
      "id": "<id-2>", "name": "researcher", "status": "running",
      "parent_id": "<id-1>", "children": []
    }
  ]
}
```

## 示例

**场景**：root agent 派活前先查一下子 agent 是否已存在。

```bash
group_architecture()
```

**预期返回**：

```json
{
  "rootId": "r-1",
  "agents": [
    { "id": "r-1", "name": "root", "status": "running", "parent_id": null, "children": ["r-2"] },
    { "id": "r-2", "name": "researcher", "status": "running", "parent_id": "r-1", "children": [] }
  ]
}
```

## 相关

- [create_agent](./create-agent) — 创建后这里能看到
- [destroy_agent](./destroy-agent) — 销毁后这里看不到

## 注意事项

- 调用时拿的是**快照**，没有强一致性；并发创建/销毁可能短暂看到中间态
- 用 agent **name**（不是 id）调 `destroy_agent` / `send_message` 更稳
