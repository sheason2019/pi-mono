---
title: agent_network
sidebar_position: 4
---

# agent_network

一句话：查整个 agent 树，返回所有 agent 的状态、父子关系。

## 用法

工具名 `agent_network`。无参数，立即返回当前 hub 上的拓扑快照。

## 参数

无。

## 返回值

返回包含 `text` 字段（给 LLM 看的格式化文本）和 `details.agents` 字段（结构化数据）的双层响应。

### 给 LLM 看的文本格式

```text
Agent Network:
  root [ready] → [r-2]
  researcher [busy]
  writer [ready]

Use agent names (e.g. "root") for destroy_agent and send_message.
```

缩进代表深度，每个 agent 一行，状态在 `[]` 里，children 用 `→ [...]` 表示。

### 结构化数据 (`details.agents`)

```json
{
  "rootId": "r-1",
  "agents": [
    {
      "id": "r-1",
      "name": "root",
      "parentId": undefined,
      "status": "ready",
      "model": "anthropic/claude-sonnet-4-20250514",
      "children": ["r-2"]
    },
    {
      "id": "r-2",
      "name": "researcher",
      "parentId": "r-1",
      "status": "busy",
      "model": undefined,
      "children": []
    }
  ]
}
```

**字段说明**：

| 字段 | 含义 |
|---|---|
| `rootId` | 树根 agent id；遍历从这里开始 |
| `agents[]` | **扁平**列表，parent-child 通过 `parentId` + `children[]` 表达 |
| `id` | 唯一 id（UUID） |
| `name` | agent 名字（同一个 hub 内唯一） |
| `parentId` | 父 agent id，root 的 `parentId` 是 `undefined` |
| `status` | agent 状态，见下表 |
| `model` | agent 用的 model 规格，可能为 `undefined`（用 default） |
| `children` | 直接子 agent id 列表（按创建顺序） |

### status 枚举

`status` 是 `AgentStatus` 类型，取值：

| 值 | 含义 |
|---|---|
| `starting` | 子进程刚拉起，还没收到首个 LLM ready 信号 |
| `ready` | 已就绪，等待输入 |
| `busy` | 正在跑 LLM 推理或工具调用 |
| `error` | worker 进程异常退出或初始化失败 |
| `destroyed` | 已销毁（`destroy_agent` 后或 worker 自然退出） |

注：**不是 `running`**。`running` 不在枚举里。

## 示例

**场景**：root agent 派活前先查一下子 agent 是否已存在。

```bash
agent_network()
```

**预期返回**（LLM 看到的 text）：

```text
Agent Network:
  root [ready] → [r-2]
  researcher [busy]

Use agent names (e.g. "root") for destroy_agent and send_message.
```

`details.agents` 是上面那个 JSON 数组。

## 树形是怎么从扁平数据算出来的

snapshot 是**扁平列表**，不是嵌套对象。树形来自 `parentId` + `children[]` 指针，hub 客户端（slash `/agents` 用的）走两步：

1. 从 `rootId` 开始深度优先遍历 `children[]`
2. 把没被遍历到的 agent 追加为"孤立节点"（孤儿）

`agent_network` 工具走类似路径，但输出是缩进文本：

```
root [ready] → [r-2, r-3]
  researcher [busy]
  writer [ready]
    writer-sub [starting]
```

## 相关

- [create_agent](./create-agent) — 创建后这里能看到
- [destroy_agent](./destroy-agent) — 销毁后这里看不到
- [角色 Roles](../agent-network/roles) — agent 关联的 role 不在 snapshot 里（看 `agents/<name>/agent.json`）

## 注意事项

- 调用时拿的是**快照**，没有强一致性；并发创建/销毁可能短暂看到中间态
- 状态可能在 hub 拿到 snapshot 之后、agent 看到之间就变了
- 用 agent **name**（不是 id）调 `destroy_agent` / `send_message` 更稳
- snapshot **不**包含 role 信息（`roles` 字段在 `agents/<name>/agent.json` 里）
