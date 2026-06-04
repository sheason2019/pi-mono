---
title: DPI_AUTH_TOKEN
sidebar_position: 3
---

# DPI_AUTH_TOKEN

一句话：`d-pi connect` 客户端必带的 bearer token，hub 用来验证调用方身份。

## 用法

环境变量方式：

```bash
export DPI_AUTH_TOKEN=<your-token>
d-pi connect --url http://hub.example.com:39090
```

或单次前缀：

```bash
DPI_AUTH_TOKEN=<your-token> d-pi connect --url http://hub.example.com:39090
```

## 怎么拿 token

hub 第一次启动会为当前 OS 用户生成一个 token，存到 `.dpi/hub-state.json`：

```bash
cat .dpi/hub-state.json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['tokens'][0])"
```

把输出复制下来当 token 用。

## 行为

hub 收到 client 请求时：

1. 从 `Authorization: Bearer <token>` 头拿 token
2. 在 hub 内部 token 表里查找
3. 找到 → 接受；找不到 → 401

## 跨机器共享

如果你想让另一台机器上的 client 连这个 hub：

1. 在 hub 机器生成一个新 token
2. 复制到 client 机器（用 secret manager、scp、或其他安全通道）
3. client 端 `export DPI_AUTH_TOKEN=<that-token>`
4. client 端 `d-pi allow-user add <name> --key <pubkey>` 登记 client 公钥（如果开了公钥校验）

## 相关

- [用户管理](./users)
- [允许的用户](./allow-user)
- [connect 命令](../getting-started/connect)

## 注意事项

- token 等同于密码，泄露 = 失去 hub 控制权
- 当前 alpha 默认**开启** auth（无 `--no-auth` 之类的关法），所有 client 必须带 token
- 失效 token 立即 401，client TUI 会显示 401 错误

