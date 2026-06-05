---
title: 允许的用户
sidebar_position: 3
---

# d-pi allow-user

一句话：白名单——只有名单里的 **publicKey** 才能连到 hub。私钥永远不离开 client。

`allow-user` 是 **hub 端**命令（必须在 d-pi workspace 根目录跑），跟 `d-pi users`（client 端，存 `~/.d-pi/users/`）**完全分两个地方**。

## 它跟 `d-pi users` 的关系

| 命令 | 跑在哪 | 存什么 |
|---|---|---|
| `d-pi users create` | client 机器 | ed25519 密钥对（含私钥）→ `~/.d-pi/users/<name>.json` |
| `d-pi allow-user add` | hub 机器（workspace） | publicKey + disabled 标志 → `<workspace>/auths/secrets/<name>.json` |

`allow-user` **永远只存公钥**——`createAllowedUser`（`allowed-users.ts:44-65`）校验 `publicKey` 非空但不存私钥。

## 子命令

| 命令 | 用途 |
|---|---|
| `d-pi allow-user add <name>` | 加入白名单（必须有 `--key`） |
| `d-pi allow-user list` | 列出白名单 |
| `d-pi allow-user update <name>` | 改 key / description / 启停 |
| `d-pi allow-user remove <name>` | 从白名单移除 |

## 用法

**添加 user 到白名单**（在 hub 机器的 workspace 根）：

```bash
d-pi allow-user add alice \
  --key MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI \
  --description "Alice's laptop"
```

实际输出：

```
Allowed user alice
description: Alice's laptop
publicKey: MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI
```

**列出**：

```bash
d-pi allow-user list
```

每行一个 allowed user：`<name>\t<description>\t<publicKey>\t<disabled>`。

**更新**（改 key / description / 启停）：

```bash
d-pi allow-user update alice --key <new-publicKey> --description "Renamed"
d-pi allow-user update alice --disabled true   # 禁用
d-pi allow-user update alice --disabled false  # 重新启用
```

**删除**：

```bash
d-pi allow-user remove alice
```

会删掉 `<workspace>/auths/secrets/alice.json`。

## 参数

`add` / `update` 共用：

| 标志 | 说明 | 必填 |
|---|---|---|
| `--key` | ed25519 SPKI 公钥，base64url 编码（**没有** `ed25519:` 前缀） | add 必填；update 可选 |
| `--description` | 描述 | 否 |
| `--disabled` | `true` / `false`；不禁用 = `false` | 否 |

`--key` 校验：`createAllowedUser`（`allowed-users.ts:46-48`）会检查非空字符串，否则抛 `public key is required`。

## 底层数据

**`<workspace>/auths/secrets/<name>.json`**（`allowed-users.ts:18-23`）：

```ts
interface AllowedUser extends StoredIdentity {
  disabled: boolean;
}

interface StoredIdentity {
  name: string;
  description: string;
  publicKey: string;       // ed25519 SPKI, base64url
  createdAt: string;
  updatedAt: string;
}
```

注意：`AllowedUser` **没有** `privateKey` 字段——hub 永远不接触私钥。

## 流程（与 users 配合）

```
1. [client]  d-pi users create alice
            → 打印 publicKey (base64url)

2. [hub]     d-pi allow-user add alice --key <publicKey>
            → 白名单生效，alice 可以 connect

3. [client]  d-pi connect alice@http://hub:39090
            → 自动 challenge-response
            → 拿到 session token
            → 连上 hub
```

顺序错会怎样：
- 第 2 步漏跑 → 401（公钥不在白名单）
- publicKey 拼错 → 401（白名单里找不到匹配）
- 第 1 步漏跑 → `Local user not found: alice`（`createConnectSession` 读不到 `~/.d-pi/users/alice.json`）

## 相关

- [概览](./overview) —— auth 整体流程图
- [用户管理 (users)](./users) —— 怎么创建 local user 拿 publicKey
- [DPI_AUTH_TOKEN](./dpi-auth-token) —— session token 从哪来

## 注意事项

- `allow-user` **必须**在 d-pi workspace 根目录跑（`handleAllowUser` 入口检查 `isWorkspaceRoot(runtime.cwd)`）
- 公钥是 base64url 编码，**没有** `ed25519:` 前缀——直接复制 `d-pi users create` 输出的那行
- 多个用户共享一个 hub 时，每个用户加一行 `allow-user add`，互相隔离
- 名字只允许 `[A-Za-z0-9._-]+`
- 删 `allow-user` 后已签发的 session token **仍有效**直到 hub 重启或 token 过期（auth-session.ts:22 内存表）
