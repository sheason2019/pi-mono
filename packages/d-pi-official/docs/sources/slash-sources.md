---
title: /sources
sidebar_position: 6
---

# /sources

一句话：在 client TUI 里以面板形式查看 hub 上所有 source。

## 用法

在 `d-pi connect` TUI 里输入：

```
/sources
```

TUI 弹出一个 panel，列出所有 source 及其状态：

```
Sources (3)
  app-logs [running] command="tail -f /var/log/app.log" subscribers=2
  ps-aux [running] command="ps aux | head -20" subscribers=0
  build-watch [stopped] command="npm run watch" subscribers=0
```

## 行为

- 命令在 client 端发 HTTP 请求到 hub（`GET /_hub/sources`）
- hub 返回 JSON，client 渲染成可滚动 panel
- 仅查看，不可操作（创建/订阅还得调工具）
- Esc 退出 panel

## 相关

- [list_sources 工具](./list-sources) — agent 用
- [create_source](./create-source) — agent 创建

## 注意事项

- 命令在 client 端执行，所以需要 `DPI_AUTH_TOKEN` 配对
- source 命令本身跑在 hub 机器上（不是 client 机器）

