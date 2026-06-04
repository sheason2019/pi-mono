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
| `roles` | string[] | 否 | 从 `.dpi/agent-network/roles/<name>/` 应用的 role 列表 |
| `tools` | string[] | 否 | 工具白名单，限制子 agent 只能调这些工具 |
| `excludeTools` | string[] | 否 | 工具黑名单，从全部工具里排除这些 |

## 返回值

```json
{
  "id": "uuid-xxx",
  "name": "researcher",
  "parent_id": "uuid-yyy"
}
```

## 示例

**场景 1**：root agent 创建一个负责查文档的子 agent（不指定 role，用 default 上下文）。

```bash
create_agent(name="researcher", prompt="你是文档查询专家")
```

**预期返回**：

```json
{ "id": "a1b2-...", "name": "researcher", "parent_id": "<caller-id>" }
```

**场景 2**：派一个 reviewer 角色做代码审查（套用 `.dpi/agent-network/roles/reviewer/` 下的预设）。

```bash
create_agent(name="cr-1", roles=["reviewer"])
```

`cr-1` 子 agent 启动时会自动加载 reviewer role 目录下的 AGENTS.md / skills / extensions。详见 [角色 Roles](../agent-network/roles)。

**场景 3**：派一个只读权限的子 agent（不能写、不能改）。

```bash
create_agent(name="auditor", roles=["reviewer"], excludeTools=["write", "edit", "bash"])
```

## 相关

- [agent_network](./agent-network) — 查子 agent 是否已存在
- [send_message](./send-message) — 派活给子 agent
- [destroy_agent](./destroy-agent) — 收尾时清理
- [角色 Roles](../agent-network/roles) — `roles` 参数详解

## 注意事项

- 子 agent 创建后会进入 `starting` 状态，等首个 LLM 调用完成才进入 `ready`
- `name` 一旦指定不可改；如需重命名，destroy + create
- `roles` 指定的 role 必须存在于 `.dpi/agent-network/roles/<name>/`，否则会抛 `Unknown agent role "<name>"`
- 同一个 agent 可以同时有多个 role，资源按"靠后覆盖"合并
- `roles` 配置被持久化到 `agents/<name>/agent.json`，hub 重启后自动恢复
- `tools` / `excludeTools` 优先级：agent 自己的 > workspace 配置
