---
title: list_sources
sidebar_position: 5
---

# list_sources

一句话：列出 hub 上所有 source及其状态。

##用法

工具名 `list_sources`。无参数。

## 返回值

工具返回纯 text列表（不是 raw JSON array，raw 数据走 `details.sources`）：

```
Sources:
 app-logs [running] command="tail -f /var/log/app.log" subscribers=2
 ps-aux [running] command="ps aux | head -20" subscribers=0

Use subscribe_source to receive messages from a source.
```

Raw `details.sources`字段（agent可见的结构化数据）：

```json
[
 {
 "name": "app-logs",
 "command": "sh",
 "args": ["-c", "tail -f /var/log/app.log | grep ERROR"],
 "status": "running",
 "subscriberCount":2
 }
]
```

### SourceInfo字段

|字段 |类型 |说明 |
|---|---|---|
| `name` |string | source名字（唯一标识，**没有 `id`字段**） |
| `command` |string | argv[0] |
| `args` |string[] |参数列表 |
| `status` |SourceStatus |见下方状态枚举 |
| `subscriberCount` |number |当前订阅 agent数 |

### SourceStatus枚举（4 值）

|值 |含义 |
|---|---|
| `running` |进程跑着，正常推送 stdout |
| `stopped` |进程退出，supervisor等待 exponential backoff 重启 |
| `error` | spawn错误或进程异常，supervisor等待重试 |
| `failed` | 重试超过 `maxRestartAttempts`（默认5）后放弃，需人工 `destroy_source` +重建 |

## 示例

```bash
list_sources()
```

**预期返回**：

```
Sources:
 app-logs [running] command="sh" subscribers=2
 ps-aux [running] command="ps aux | head -20" subscribers=0

Use subscribe_source to receive messages from a source.
```

## 相关

- [create_source](./create-source) —注册
- [subscribe_source](./subscribe-source) —订阅
- [/sources 命令](./slash-sources) — client端 select面板查看
- [overview → Source lifecycle](./overview) —4 个状态详细语义
