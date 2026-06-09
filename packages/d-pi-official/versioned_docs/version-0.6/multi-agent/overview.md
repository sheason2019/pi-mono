---
title: 概览
sidebar_position: 1
---

#多 Agent编排

d-pi的核心能力是让你用一个 root agent拆任务，每个子 agent拿一份独立上下文跑，
最后 root把结果汇总。整个 agent网络是一个**树形**拓扑，
root是树根，子 agent是中间节点，叶子 agent只做执行不做拆分。

##工具一览

|工具 |用途 |
|---|---|
| [create_agent](./create-agent) | 在当前 agent下创建子 agent（可指定 `roles`） |
| [send_message](./send-message) |派活给另一个 agent（异步） |
| [agent_network](./agent-network) |查整个 agent树 |
| [destroy_agent](./destroy-agent) |收尾时销毁子 agent |
| [meta-connect](./meta-connect) | 在 TUI输入 `connect <id>`把消息定向到指定 agent |

##角色（Roles）

角色（roles）— 见 docs/agent-network/roles（v0.7计划引入）是一类任务的可复用预设：把"指令、skill、extension"打成模板，需要时给子 agent套上。

```bash
#派一个 reviewer角色做代码审查
create_agent(name="cr", roles=["reviewer"])
```

roles的目录布局在 `agent-network/roles/<name>/`下，详见 roles文档 — 见 docs/agent-network/roles（v0.7计划引入）。

##端到端例子

root agent拿到「研究 X主题并写总结」的任务：

```
1. root: create_agent(name="researcher", roles=["researcher"])
 →子 agent进入 starting → ready状态，继承 agent-network/roles/researcher/下的资源

2. root: create_agent(name="writer", roles=["writer"])

3. root: send_message(agent_id="researcher", message="研究 X主题的5个关键点")
 → researcher收到消息 →跑 LLM →调工具 →完成

4. root: send_message(agent_id="writer", message="基于 researcher 的输出写一篇500字总结")
 → writer收到消息（**不**自动看到 researcher 的工具调用历史 — researcher 要把发现摘要显式 send_message 转写）
 → writer跑 LLM →完成

5. root: agent_network()查整个树确认两个子 agent状态

6. root:收集完结果 → destroy_agent(researcher) + destroy_agent(writer)
```

##上下文工程

「上下文工程」是把可复用的指令、skill、extension预置到 `agent-network/`目录的工程实践——这是 d-pi多 agent系统的**作者合约**。

详见 Agent Network →概览 — 见 docs/agent-network/overview（v0.7计划引入）。

## 相关

- [Sources概览](../sources/overview) — agent也可以订阅外部数据源
- [Remote Execution概览](../remote-execution/overview) — agent调的工具跑在哪里
- 角色Roles — 见 docs/agent-network/roles（v0.7计划引入） —可复用的 agent预设模板
