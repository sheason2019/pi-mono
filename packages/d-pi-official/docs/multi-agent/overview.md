---
title: 概览
sidebar_position: 1
---

# 多 Agent 编排

d-pi 的核心能力是让你用一个 root agent 拆任务，每个子 agent 拿一份独立上下文跑，
最后 root 把结果汇总。整个 agent 网络是一个**树形**拓扑，
root 是树根，子 agent 是中间节点，叶子 agent 只做执行不做拆分。

## 工具一览

| 工具 | 用途 |
|---|---|
| [create_agent](./create-agent) | 在当前 agent 下创建子 agent（可指定 `roles`） |
| [send_message](./send-message) | 派活给另一个 agent（异步） |
| [agent_network](./agent-network) | 查整个 agent 树 |
| [destroy_agent](./destroy-agent) | 收尾时销毁子 agent |
| [meta-connect](./meta-connect) | 在 TUI 输入 `connect <id>` 把消息定向到指定 agent |

## 角色（Roles）

[角色（roles）](../agent-network/roles) 是一类任务的可复用预设：把"指令、skill、extension"打成模板，需要时给子 agent 套上。

```bash
# 派一个 reviewer 角色做代码审查
create_agent(name="cr", roles=["reviewer"])
```

roles 的目录布局在 `.dpi/agent-network/roles/<name>/` 下，详见 [roles 文档](../agent-network/roles)。

## 端到端例子

root agent 拿到「研究 X 主题并写总结」的任务：

```
1. root: create_agent(name="researcher", roles=["researcher"])
   → 子 agent 进入 starting → ready 状态，继承 .dpi/agent-network/roles/researcher/ 下的资源

2. root: create_agent(name="writer", roles=["writer"])

3. root: send_message(agent_id="researcher", message="研究 X 主题的 5 个关键点")
   → researcher 收到消息 → 跑 LLM → 调工具 → 完成

4. root: send_message(agent_id="writer", message="基于 researcher 的输出写一篇 500 字总结")
   → writer 把 researcher 的历史（通过 hub 共享）作为上下文

5. root: agent_network() 查整个树确认两个子 agent 状态

6. root: 收集完结果 → destroy_agent(researcher) + destroy_agent(writer)
```

## 上下文工程

「上下文工程」是把可复用的指令、skill、extension 预置到 `.dpi/agent-network/` 目录的工程实践——这是 d-pi 多 agent 系统的**作者合约**。

详见 [Agent Network → 概览](../agent-network/overview)。

## 相关

- [Sources 概览](../sources/overview) — agent 也可以订阅外部数据源
- [Remote Execution 概览](../remote-execution/overview) — agent 调的工具跑在哪里
- [角色 Roles](../agent-network/roles) — 可复用的 agent 预设模板
