---
title: 用户管理
sidebar_position: 1
---

# d-pi users

一句话：管理 hub 上**本地的**用户账号（用于人/客户端身份，不影响 LLM provider）。

## 子命令

| 命令 | 用途 |
|---|---|
| `d-pi users create <name>` | 创建本地用户 |
| `d-pi users list` | 列出所有用户 |
| `d-pi users update <name>` | 更新 description |
| `d-pi users delete <name>` | 删除用户 |

## 用法

创建用户：

```bash
d-pi users create alice --description "Alice's local account"
```

输出：

```
Created local user alice
description: Alice's local account
publicKey: ed25519:...
```

列出：

```bash
d-pi users list
```

更新：

```bash
d-pi users update alice --description "Alice (admin)"
```

删除：

```bash
d-pi users delete alice
```

## 参数

`create` / `update` 共用：

| 标志 | 说明 |
|---|---|
| `--description` | 用户描述 |

## 相关

- [允许的用户](./allow-user) — 控制谁能连 hub
- [DPI_AUTH_TOKEN](./dpi-auth-token) — 客户端 auth 头

## 注意事项

- 本地用户**不**等同于 LLM provider 账号；它只用于 hub 侧身份
- 删用户不影响其历史 session（sessions 持久化在 `.dpi/sessions/`）

