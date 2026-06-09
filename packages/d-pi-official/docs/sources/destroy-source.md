---
title: destroy_source
sidebar_position: 7
---

# destroy_source

一句话：销毁一个 source（必须先 unsubscribe 所有 agent）。

## 用法

工具名 `destroy_source`。Agent用来收尾 source。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `name` |string |是 | source名字 |

##返回值

工具返回**纯 text**：

```
Source "app-logs" destroyed
```

##示例

**场景**:app-logs source 已 unsubscribe所有 agent，现在销毁。

```bash
destroy_source(name="app-logs")
```

**预期返回**:

```
Source "app-logs" destroyed
```

## 相关

- [create_source](./create-source) —创建
- [subscribe_source](./subscribe-source) —订阅
- [unsubscribe_source](./unsubscribe-source) —取消订阅
- [list_sources](./list-sources) —查看状态

##注意事项

- **必须先 unsubscribe 所有 agent** —`SourceManager.destroySource` 在 `record.subscribers.size >0` 时抛 `Cannot destroy source "X": <count> subscriber(s) still active (<list>). Unsubscribe all agents first.`
- destroy 是终态：destroyed source **不**会被 supervisor restart拉起
- 如果 source处于 `failed`状态（重试超过 `maxRestartAttempts`），仍可 destroy
- destroy 后该 source的 `name` 在 hub内释放，可重新 `create_source(name=...)` 注册同名 source
