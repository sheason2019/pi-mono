---
title: list_sources
sidebar_position: 5
---

# list_sources

一句话：列出 hub 上所有 source 及其状态。

## 用法

工具名 `list_sources`。无参数。

## 返回值

```json
[
  {
    "id": "s-1",
    "name": "app-logs",
    "status": "running",
    "command": "tail -f /var/log/app.log",
    "subscriberCount": 2
  },
  {
    "id": "s-2",
    "name": "ps-aux",
    "status": "running",
    "command": "ps aux | head -20",
    "subscriberCount": 0
  }
]
```

## 示例

```bash
list_sources()
```

## 相关

- [create_source](./create-source) — 注册
- [subscribe_source](./subscribe-source) — 订阅
- [/sources 命令](./slash-sources) — client 端图形化查看

