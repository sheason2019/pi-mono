---
title: connect <id>
sidebar_position: 6
---

# connect &lt;id&gt;

一句话：在 client TUI 输入 `connect <id_or_name>`，把后续消息定向到指定 agent。

## 用法

在 d-pi connect TUI 里输入：

```
connect researcher
```

或用 id：

```
connect r-2
```

TUI 提示切换到该 agent 的会话上下文，后续你输入的内容直接派给该 agent。

## 行为

- 当前 agent 会收到一条 `meta` 消息，标记为「用户已切到 `<id>`」
- TUI prompt 区显示当前目标 agent 名字
- 后续用户消息**只发给**目标 agent，不发当前 agent
- 切回原 agent：再次 `connect <原名>`

## 示例

**场景**：你在 TUI 里跟 root agent 聊着聊着，想直接跟 `researcher` 子 agent 说话。

```
> connect researcher
[d-pi] switched to agent: researcher (r-2)
> 你好，帮我查一下 X 主题
（researcher 收到并开始处理）
```

切回来：

```
> connect root
[d-pi] switched to agent: root (r-1)
```

## 相关

- [agent_network](../multi-agent/agent-network) — 查 agent id / name
- [/agents 命令](../remote-execution/slash-agents) — 图形化切换

## 注意事项

- `connect` 切的是**消息路由**，不是切换 TUI 主题；TUI 仍然显示同一个 root 会话
- meta 消息会被注入到原 agent 的上下文（带 `connect` 标记），原 agent 看到你切走了
