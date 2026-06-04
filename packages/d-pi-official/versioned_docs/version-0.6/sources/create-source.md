---
title: create_source
sidebar_position: 2
---

# create_source

一句话：注册一个 source（一条 shell 命令），hub 拉起子进程跑它，stdout 流到订阅者。

## 用法

工具名 `create_source`。Agent 用来把外部数据接入上下文。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | source 名字，hub 内唯一 |
| `command` | string | 是 | 完整 shell 命令（含参数） |
| `cwd` | string | 否 | 命令运行目录 |

## 返回值

```json
{
  "id": "<source-id>",
  "name": "app-logs",
  "status": "running",
  "command": "tail -f /var/log/app.log"
}
```

## 示例

**场景**：agent 监控应用日志。

```bash
create_source(name="app-logs", command="tail -f /var/log/app.log")
```

**预期返回**：

```json
{ "id": "s-1", "name": "app-logs", "status": "running", "command": "tail -f /var/log/app.log" }
```

随后 `subscribe_source(source_name="app-logs")` 即可开始接收日志。

## 相关

- [subscribe_source](./subscribe-source)
- [list_sources](./list-sources)
- [unsubscribe_source](./unsubscribe-source)

## 注意事项

- 命令在 **hub 所在机器** 上跑（不是 client 机器）
- `command` 走 shell 解释，支持 `|` / `&&` 等
- 大流量命令（每秒上千行）可能拖慢 agent；考虑加 `grep` / `awk` 过滤

