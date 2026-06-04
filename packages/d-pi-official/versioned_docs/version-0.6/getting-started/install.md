---
title: 安装
sidebar_position: 1
---

# 安装 d-pi

一句话：通过 npm 全局安装 d-pi CLI。

## 用法

```bash
npm install -g @sheason/d-pi
```

装好后 `d-pi --version` 验证：

```bash
$ d-pi --version
0.6.0-alpha.1
```

## 系统要求

- Node.js 18+（d-pi 跟 pi 一样要求 Node 18 LTS 或更高）
- macOS / Linux / WSL（Windows native 未测试）
- 一台 LLM provider 的 API key（Anthropic / OpenAI / ...）

## 相关

- [初始化 workspace](./init)
- [启动 hub](./serve)
