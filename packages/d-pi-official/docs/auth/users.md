---
title: 用户管理
sidebar_position: 2
---

# d-pi users

一句话：在 **client 机器的 `~/.d-pi/users/`** 下管理 local user 账号——每个 user 带一对 ed25519 密钥，私钥存本地用于签 challenge。

## 它跟 hub 的关系

`d-pi users` 是 **client 端**命令（不连 hub），在 `$HOME` 目录下读写 local user 文件。**hub 完全不感知这个命令**——hub 看到的只有公钥（从 `allow-user add` 传过来）。

| 数据 | 命令 | 位置 |
|---|---|---|
| Local user（含密钥对） | `d-pi users ...` | `~/.d-pi/users/<name>.json` |
| Allowed user（白名单） | `d-pi allow-user ...` | `<workspace>/auths/secrets/<name>.json` |

详见 [概览](./overview) 跟 [允许的用户](./allow-user)。

## 子命令

| 命令 | 用途 |
|---|---|
| `d-pi users create <name>` | 创建 local user，生成 ed25519 密钥对 |
| `d-pi users list` | 列出所有 local user |
| `d-pi users update <name>` | 更新 description |
| `d-pi users delete <name>` | 删除 local user |

## 用法

**创建 user**（在 client 机器）：

```bash
d-pi users create alice --description "Alice's laptop"
```

实际输出（实测过）：

```
Created local user alice
description: Alice's laptop
publicKey: MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI
```

`publicKey` 是 **base64url 编码的 ed25519 SPKI 公钥**，**没有** `ed25519:` 前缀。长度约 59 字符。

**拿到 publicKey 后**，拷贝到 hub 机器跑：

```bash
d-pi allow-user add alice --key MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI
```

详见 [allow-user](./allow-user)。

**列出**：

```bash
d-pi users list
```

输出每行一个 user：`<name>\t<description>\t<publicKey>`。

**更新**：

```bash
d-pi users update alice --description "Alice (admin)"
```

只能改 `description`（`name` 跟密钥对不可改）。

**删除**：

```bash
d-pi users delete alice
```

会删掉 `~/.d-pi/users/alice.json`。**已经在 hub 白名单里的 publicKey 不会自动撤销**——`allow-user remove` 要单独跑。

## 参数

`create` / `update` 共用：

| 标志 | 说明 | 必填 |
|---|---|---|
| `--description` | 用户描述 | 否（可空字符串） |

## 底层数据

**`~/.d-pi/users/<name>.json`**（`local-users.ts:4-11, 14`）：

```ts
interface StoredIdentity {
  name: string;
  description: string;
  publicKey: string;       // ed25519 SPKI, base64url 编码
  createdAt: string;      // ISO 8601
  updatedAt: string;
}

interface LocalUser extends StoredIdentity {
  privateKey: string;      // ed25519 PKCS8, base64url 编码
}
```

权限：私钥文件 mode `0o600`（仅当前用户可读写），由 `common.ts:writeJsonFile` 强制设置。

## 相关

- [概览](./overview) —— auth 整体流程（3 步）
- [允许的用户](./allow-user) —— 怎么把 publicKey 加到 hub 白名单
- [DPI_AUTH_TOKEN](./dpi-auth-token) —— 怎么用 alice 的密钥自动签 challenge 拿 session token
- [connect 命令](../getting-started/connect) —— `<user>@<url>` 语法怎么用

## 注意事项

- Local user **不**等同于 LLM provider 账号；它只用于 d-pi hub 侧身份
- Local user 文件在 `$HOME/.d-pi/`，**不是** workspace——换机器要重新 `d-pi users create`
- 删除 local user **不**自动撤销 `allow-user` 里的白名单；要两边都删
- 私钥 mode 是 `0o600`，别用 `chmod` 改
- 名字只允许 `[A-Za-z0-9._-]+`（`common.ts:assertValidName`）
