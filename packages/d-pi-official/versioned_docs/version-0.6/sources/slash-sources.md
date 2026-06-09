---
title: /sources
sidebar_position: 6
---

# /sources

一句话：在 client TUI 里以 select 选择面板查看 hub 上所有 source。

##用法

在 `d-pi connect` TUI 里输入：

```
/sources
```

TUI弹出一个 **select 选择面板**（上下键导航，Enter选中 /取消），列出所有 source及其状态：

```
Sources (3)
 app-logs [running] command="tail -f /var/log/app.log" subscribers=2
 ps-aux [running] command="ps aux | head -20" subscribers=0
 build-watch [stopped] command="npm run watch" subscribers=0
```

##行为

- 命令在 client端发 HTTP 请求到 hub（`GET /_hub/sources`）
- hub 返回 raw `SourceInfo[]` JSON，client渲染成 select 选择面板
- 仅查看，**不可操作**（创建 /订阅 /取消订阅 /销毁还得调工具）
-上下键在选项间导航，Enter选中 /取消

## 相关

- [list_sources工具](./list-sources) — agent用
- [create_source](./create-source) — agent创建
- [destroy_source](../reference/tools) — agent销毁

##注意事项

- 命令在 client端执行，所以需要 client配 `DPI_AUTH_TOKEN`跟 hub 的 bearer token 对齐（hub auth开启时；hub auth关闭时不需）
- source命令本身跑在 hub机器上（不是 client机器）
-面板显示的 status 是 hub当前状态（`running` / `stopped` / `error` / `failed`，参 [overview → Source lifecycle](./overview)）
