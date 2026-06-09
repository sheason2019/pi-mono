---
title: "connect <id>"
sidebar_position: 6
---

# connect &lt;id&gt;

一句话：在 client TUI输入 `connect <id_or_name>`，整个 TUI 会话切换到指定 agent（respawn机制）。

## 用法

在 d-pi connect TUI里输入：

```
connect researcher
```

或用 id：

```
connect9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

##行为（respawn机制）

`connect <id>` **不**是「meta消息切换」——实际是整个 TUI 会话**重新拉起**到目标 agent：

1. 当前 `_connect-child`（TUI进程）退出，写入 `AGENT_SWITCH_FILE`（`os.tmpdir() + "d-pi-agent-switch.txt"`），文件内容为目标 agent id
2.父 `d-pi connect`进程读到这个文件，`unlink` 后清屏 (`\x1B[2J\x1B[H`)
3.父进程重新走 `runConnectSession`，重新拉起 `_connect-child`（连到目标 agent）+ `_executor-child`（client端工具 executor）
4. 新 TUI 进入目标 agent 的会话上下文；prompt 区显示「你现在跟 &lt;name&gt; 对话」

**重要后果**：

-旧 agent **不**收到一条 "用户切走了" 的 meta消息 ——它只看到自己的 TUI 子进程被 kill
- 没有"切回原 agent"的概念 ——再次 `connect <原名>` 会 respawn回到原 agent（重走一遍 challenge-response拿新 session token）
- terminal状态（光标、kitty协议、bracketed paste）在切换间会被正确重置

## 示例

**场景**：你在 TUI里跟 root agent聊着聊着，想直接跟 `researcher` 子 agent说话。

```
> connect researcher
[TUI退出 + 重启 + 连到 researcher]
[d-pi] You are now connected to agent: researcher
> 你好，帮我查一下 X主题
（researcher收到并开始处理）
```

切回来：

```
> connect root
[TUI退出 + 重启 + 连到 root]
[d-pi] You are now connected to agent: root
```

## 相关

- [agent_network](../multi-agent/agent-network) —查 agent id / name
- [/agents命令](../remote-execution/slash-agents) —图形化切换（走 select面板，本质也是 respawn）

##注意事项

- `connect <id>`切的是整个 TUI 会话（respawn），不是「在同一个 session 里切换路由」
- AGENT_SWITCH_FILE（`os.tmpdir()/d-pi-agent-switch.txt`）是 respawn 信号文件；旧 TUI退出时写，新 TUI启动时清
-切换会重走 auth challenge-response（除非 DPI_AUTH_TOKEN env已设）——session token 是短期的，每次 respawn 可能换
- TUI切走时旧 agent不会收到 meta消息；要让旧 agent知道，需显式 send_message
