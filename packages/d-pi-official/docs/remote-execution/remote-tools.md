---
title: remote_* 工具集
sidebar_position: 3
---

# remote_* 工具集

一句话：7 个 `remote_*` 工具对应 7 个 pi native 工具，agent 调用时执行在 client 机器。

## 工具清单

| 工具 | 等价 native | 用途 |
|---|---|---|
| `remote_bash` | `bash` | 跑 shell 命令 |
| `remote_read` | `read` | 读文件 |
| `remote_ls` | `ls` | 列目录 |
| `remote_grep` | `grep` | 按 pattern 搜内容 |
| `remote_find` | `find` | 按文件名搜 |
| `remote_write` | `write` | 写文件 |
| `remote_edit` | `edit` | 局部编辑 |

每个工具的参数、返回值跟 native 版本**完全一致**，只是工具名前缀 `remote_`。

## 调用方式

agent 调工具时直接用：

```
remote_read(path="/Users/me/.zshrc")
remote_bash(command="ls -la /tmp | head -5")
remote_grep(pattern="TODO", path="/Users/me/projects")
```

## 工具背后

`remote_*` 是 d-pi 的 inline extension 注册到 agent worker 的：

```
agent LLM 输出: remote_read(path="/Users/me/.zshrc")
  ↓
remote_read.execute() 内部发 POST /agents/<id>/remote-call 到 hub
  ↓
hub 路由到对应 connect_id 的 executor
  ↓
executor 在 client 机器跑 read("/Users/me/.zshrc")
  ↓
结果回 agent
```

## AbortSignal 透传

agent 决策时按 Ctrl+C 取消工具调用，会：

1. agent → remote_*.execute() 收到 AbortSignal
2. fetch 带 signal → hub
3. hub → executor SSE
4. executor 调用 native tool 时传 signal
5. 工具被中止，agent 收到 abort 错误

## 相关

- [概览](./overview)
- [executor 生命周期](./executor-lifecycle)
- [参考 → Agent 工具](../reference/tools) — 完整工具参数表

## 注意事项

- 工具执行在 **client 机器的 cwd**，不是 agent worker 的 cwd
- `remote_bash` 跑的是 client 用户的 shell，权限跟 client 登录用户一致
- 大文件（>1MB）可能拖慢；考虑分块读

