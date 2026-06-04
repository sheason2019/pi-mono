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
| [create_agent](./create-agent) | 在当前 agent 下创建子 agent |
| [send_message](./send-message) | 派活给另一个 agent（异步） |
| [agent_network](./agent-network) | 查整个 agent 树 |
| [destroy_agent](./destroy-agent) | 收尾时销毁子 agent |
| [meta-connect](./meta-connect) | 在 TUI 输入 `connect <id>` 把消息定向到指定 agent |

## 端到端例子

root agent 拿到「研究 X 主题并写总结」的任务：

```
1. root: create_agent(name="researcher", prompt="你是研究助手")
   → 子 agent 进入 starting → running 状态

2. root: create_agent(name="writer", prompt="你是写作助手")

3. root: send_message(agent_id="researcher", message="研究 X 主题的 5 个关键点")
   → researcher 收到消息 → 跑 LLM → 调工具 → 完成

4. root: send_message(agent_id="writer", message="基于 researcher 的输出写一篇 500 字总结")
   → writer 把 researcher 的历史（通过 hub 共享）作为上下文

5. root: agent_network() 查整个树确认两个子 agent 状态

6. root: 收集完结果 → destroy_agent(researcher) + destroy_agent(writer)
```

## 相关

- [Sources 概览](../sources/overview) — agent 也可以订阅外部数据源
- [Remote Execution 概览](../remote-execution/overview) — agent 调的工具跑在哪里
