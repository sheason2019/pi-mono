---
title: unsubscribe_source
sidebar_position: 4
---

# unsubscribe_source

一句话：取消对 source 的订阅，agent上下文不再收到新数据。

##用法

工具名 `unsubscribe_source`。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `source_name` |string |是 | source名字 |

##返回值

工具返回纯 text：

```
Unsubscribed from source "app-logs"
```

## 示例

```bash
unsubscribe_source(source_name="app-logs")
```

**预期返回**：

```
Unsubscribed from source "app-logs"
```

## 相关

- [subscribe_source](./subscribe-source) —对面
- [destroy_source](../reference/tools) — unsubscribe后销毁 source
