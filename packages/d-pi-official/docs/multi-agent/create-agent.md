---
title: create_agent
sidebar_position: 2
---

# create_agent

一句话：在当前 agent下创建一个子 agent，返回子 agent 的 id。

## 用法

工具名 `create_agent`。Agent在需要把任务委派给子 agent时调用。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `name` | string |是 | 子 agent名字，hub内唯一 |
| `cwd` | string |否 | 子 agent工作目录（默认 `workspace/agents/<name>/`） |
| `model` | string |否 | 子 agent的 model（e.g. `anthropic/claude-sonnet-4`）；省略 = workspace default |
| `roles` | string[] |否 | 从 `group-architecture/roles/<name>/`应用的 role列表 |
| `includeTools` | string[] |否 |工具白名单，限制子 agent只能调这些工具 |
| `excludeTools` | string[] |否 |工具黑名单，从全部工具里排除这些 |
| `includeTools` / `excludeTools` | — | — | 互斥：只能传其中一个。都不传 = 继承 workspace 默认 / 全部启用。|

**注意**：父 agent **不能**在工具调用里显式指定 ——父是 caller agent 自动隐式确定。要「把 agent挂在别的 parent下」，需要重建时显式传。

##返回值

工具返回**纯 text**（不是 JSON 结构）：

```
Created agent "researcher" (ID:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d)
```

`details.agentId`字段是结构化的 UUID，供后续 `send_message` / `destroy_agent` / `group_architecture` 用。

## 示例

**场景1**：root agent创建一个负责查文档的子 agent（不指定 role，用 default上下文）。

```bash
create_agent(name="researcher")
```

**预期返回**：

```
Created agent "researcher" (ID:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d)
```

**场景2**：派一个 reviewer角色做代码审查（套用 `group-architecture/roles/reviewer/`下的预设）。

```bash
create_agent(name="cr-1", roles=["reviewer"])
```

`cr-1` 子 agent启动时会自动加载 reviewer role目录下的 AGENTS.md / skills / extensions。详见 [角色Roles](../group-architecture/roles)。

**场景3**：派一个只读权限的子 agent（不能写、不能改）。

```bash
create_agent(name="auditor", roles=["reviewer"], exclude_tools=["write", "edit", "bash"])
```

## 相关

- [group_architecture](./group-architecture) —查子 agent是否已存在
- [send_message](./send-message) —派活给子 agent
- [destroy_agent](./destroy-agent) —收尾时清理
- [角色Roles](../group-architecture/roles) — `roles`参数详解

##注意事项

- 子 agent创建后会进入 `starting`状态，等首个 LLM 调用完成才进入 `ready`
- `name` 一旦指定不可改；如需重命名，destroy + create
- `roles`指定的 role 必须存在于 `group-architecture/roles/<name>/`，否则会抛 `Unknown agent role "<name>"`
-同一个 agent可以同时有多个 role，资源按"靠后覆盖"合并
- `roles` / `model` / `includeTools` / `excludeTools` 配置被持久化到 `agents/<name>/agent.json`，hub重启后自动恢复
- `includeTools` / `excludeTools`优先级：agent自己的 > workspace配置
