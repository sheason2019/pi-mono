---
title: 概览
sidebar_position: 1
---

# Group Architecture目录约定

一句话：`group-architecture/`下的文件系统布局就是 d-pi 多 agent系统的**作者合约**——你照这个布局放文件，d-pi会在 hub启动或子 agent 创建时按规则加载到对应 agent 的上下文里。

## 它解决什么问题

d-pi是个多 agent编排系统。一个真实的项目里，你会反复需要：

- 让所有 agent 都遵守项目级代码规范 → **网络级 AGENTS.md**
- 让所有 agent都能跑某套常用 skill → **网络级 skills/**
- 给一类任务（reviewer / writer / researcher）预置指令、skill、extension → **role**
- hub启动时 root 自动应用，root派子 agent 时子 agent 自动应用

这些「可复用的上下文」必须存在某个地方。**`group-architecture/` 就是 d-pi规定这个地方的格式**。

## 它不是什么

- **不是 slash 命令**——d-pi 没有 `/group-architecture` 这种命令（注册过的只有 `/sources` 和 `/agents`）
- **不是单一工具**——`group_architecture` 是 server-side **工具**（agent LLM 用），跟目录约定是两件事
- **不是运行时自动生成**——`d-pi init`不会创建 `group-architecture/`，完全靠你**手动放**

##完整目录布局

```
my-project/
├── AGENTS.md # workspace 级（不在 group-architecture 下）
├── APPEND_SYSTEM.md # workspace 级
├── .dpi/
│ └── config.json # workspace 配置（version:1）
├── group-architecture/ # ← 这就是约定目录（在 workspace根，**不**在 .dpi/ 下）
│ ├── AGENTS.md # 网络级共享上下文
│ ├── skills/ # 网络级 skill池
│ ├── extensions/ # 网络级 extension池
│ └── roles/ #角色定义
│ ├── researcher/
│ │ ├── AGENTS.md
│ │ ├── skills/
│ │ └── extensions/
│ ├── writer/
│ └── ...
├── skills/ # workspace顶级 skill池（**根**目录，不在 .dpi/ 下）
├── extensions/ # workspace顶级 extension池
└── agents/
 ├── root/
 │ ├── agent.json # root 的 wiring（含 roles字段）
 │ ├── AGENTS.md
 │ └── .pi/APPEND_SYSTEM.md
 └── <sub-agent>/
 └── agent.json # 子 agent 的 wiring（持久化的 roles）
```

## 三层结构

| 层 |位置 | 谁编辑 |加载时机 | 给谁用 |
|---|---|---|---|---|
| **Workspace 级** | `AGENTS.md` / `APPEND_SYSTEM.md`（仓库根） | 项目作者 |任何 agent启动时 | 所有 agent |
| **Network 级** | `group-architecture/{AGENTS.md, skills/, extensions/}` | 项目作者 | hub启动 + 子 agent 创建 | 所有 agent（root 自动，子 agent显式） |
| **Role 级** | `group-architecture/roles/<name>/{AGENTS.md, skills/, extensions/}` | 项目作者 |引用了此 role 的 agent启动时 |套了 role 的 agent |
| **Agent 级** | `agents/<name>/{AGENTS.md, .pi/APPEND_SYSTEM.md, agent.json}` | 项目作者 +工具 | 该 agent启动时 | 该 agent |

##加载顺序（merge）

`loadWorkspaceContext()` 把所有层资源合并成最终的 agent上下文。**靠后优先级高**（同名 AGENTS.md覆盖前面的）：

1. workspace 级 `APPEND_SYSTEM.md`（如果有）
2. **Network 级** `group-architecture/AGENTS.md` + `group-architecture/skills/` + `group-architecture/extensions/`
3. **Role 级** `group-architecture/roles/<each effective role>/{AGENTS.md, skills/, extensions/}`
4. **Workspace顶级** `skills/` + `extensions/`（根目录，不在 `group-architecture/` 下也不在 `.dpi/` 下）
5. **Agent 级** `agents/<name>/{AGENTS.md, .pi/APPEND_SYSTEM.md}`

注：merge 是「追加」语义，不是去重。LLM看到完整的多份文件内容，靠后的拼后面。

## 这一章在讲什么

- [目录约定](./directory-convention) —— 文件系统长什么样，每类文件支持什么
- [角色 Roles](./roles) —— role 子约定详解，怎么写一个 role
- [示例](./examples) ——3 个完整的 worked example（researcher / writer / reviewer）

## 相关

- [多 Agent编排 →概览](../multi-agent/overview) —— runtime视角
- [create_agent工具](../multi-agent/create-agent) ——怎么用 `roles` 参数挂载 role
- [group_architecture工具](../multi-agent/group-architecture) —— agent视角的查询入口
- [/agents 命令](../remote-execution/slash-agents) —— 人视角的运行时入口
