---
title: 允许的用户
sidebar_position: 2
---

# d-pi allow-user

一句话：白名单——只有名单里的本地用户被允许连到这个 hub。

## 子命令

| 命令 | 用途 |
|---|---|
| `d-pi allow-user add <name>` | 加入白名单 |
| `d-pi allow-user list` | 列出白名单 |
| `d-pi allow-user update <name>` | 更新 key / description / 启停 |
| `d-pi allow-user remove <name>` | 从白名单移除 |

## 用法

添加用户（带公钥）：

```bash
d-pi allow-user add alice --key ed25519:abc123... --description "Alice's laptop"
```

列出：

```bash
d-pi allow-user list
```

禁用（不删）：

```bash
d-pi allow-user update alice --disabled true
```

移除：

```bash
d-pi allow-user remove alice
```

## 参数

`add` / `update`：

| 标志 | 说明 |
|---|---|
| `--key` | 公钥（ed25519 格式） |
| `--description` | 描述 |
| `--disabled` | `true` / `false`，不禁用 = `false` |

## 相关

- [用户管理](./users) — 创建本地用户
- [DPI_AUTH_TOKEN](./dpi-auth-token) — 客户端连接时怎么带 token

## 注意事项

- `allow-user` **必须**在 d-pi workspace 根目录跑
- 第一次启动 hub 时，hub 自动为**当前 OS 用户**生成 local user + token + 加入白名单
- 多个用户共享一个 hub 时，给每个用户加 `--key` 限制访问

