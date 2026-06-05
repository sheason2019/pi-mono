---
title: DPI_AUTH_TOKEN
sidebar_position: 4
---

# DPI_AUTH_TOKEN

一句话：client 用的 **bearer session token**——client 跟 hub 走完 ed25519 challenge-response 后拿到，hub 重启就失效，**不需要也不应该手动管理**。

## 真实身份

`DPI_AUTH_TOKEN` **是 session token**，**不是**长期用户 secret：

- **短期**——只存在 hub 内存的 `_sessions: Map<string, AuthSessionInfo>`（`auth-session.ts:22`），hub 重启后整张表清空
- **不是**从任何持久化文件读出来的——`hub-state.json` **不存在**（全文零引用）
- **不**通过 `d-pi users` 或 `d-pi allow-user` 直接生成
- **唯一来源**：`d-pi connect <user>@<url>` 走完 ed25519 challenge-response 后由 hub 签发

## 怎么用

**推荐**：用 `<user>@<url>` 语法，让 connect CLI 自动签 challenge 拿 token：

```bash
d-pi connect alice@http://hub.example.com:39090
```

CLI 内部流程（`connect-mode.ts:55-59` + `connect-auth.ts:42-59`）：

```
1. 读 ~/.d-pi/users/alice.json 拿 privateKey
2. POST /_hub/auth/challenge   body: { publicKey }
3. hub 返回 { challengeId, challenge }
4. client 用 privateKey 签 challenge（ed25519）
5. POST /_hub/auth/session     body: { publicKey, challengeId, signature }
6. hub verify 通过 → 返回 { token }
7. client 把 token 当 Bearer 头带
```

**直接设 env**（跳过自动 challenge-response）：

```bash
DPI_AUTH_TOKEN=<some-token> d-pi connect --url http://hub.example.com:39090
```

什么时候用：
- 跨机器想让 client 连 hub（机器 A 上 `d-pi connect alice@hub`，机器 B 想直接复用这个 token）
- 写脚本测试
- CI 环境

`DPI_AUTH_TOKEN` 会从 `process.env` 读取（`cli-runner.ts:194` / `client-extension.ts:17` / `executor/env.ts:13`）。

## 怎么"拿"一个 token

**正常用户用不到**——`d-pi connect alice@<url>` 一次签完直接用，token 跟着 session 走。

**如果你**真的需要手动拿一个 token（比如跨机器复制），流程是：

```bash
# 1. 在 client 机器，跑个一次性脚本（CLI 没暴露这个 API）
#    —— 当前文档默认你走 d-pi connect 自动签名路径

# 2. 在 hub 机器，hub 自己也会在 _sessions 里放一份
#    但**没有** CLI 导出，需要的话得自己写：
node -e "
const { AuthSessionManager } = require('./packages/d-pi/src/auth/auth-session.ts');
" # 不推荐：模块结构是 ESM，得用 tsx

# 3. 最实用的方式：另开一个 client 跑 d-pi connect，从它自己的 _sessions 里拿
#    但 d-pi connect 不会导出 token
```

**结论**：当前 CLI 没有"导出 session token"的能力。如果你需要跨机器共享，**直接用 `<user>@<url>` 语法在目标机器上跑**——它会在新机器上独立走 challenge-response（只要 `~/.d-pi/users/<name>.json` 在新机器上存在 + hub 白名单里有该 publicKey）。

## 行为

hub 收到 client 请求时（`gateway.ts:251-252`）：

```ts
const header = req.headers.authorization;
if (!header?.startsWith("Bearer ")) return undefined;  // 401
return this._auth.verifyToken(header.slice("Bearer ".length));
```

`verifyToken`（`auth-session.ts:72-74`）：

```ts
verifyToken(token: string): AuthSessionInfo | undefined {
    return this._sessions.get(token);
}
```

找不到 → 401；找到 → 拿到 `AuthIdentity { name, description }` 进入业务逻辑。

## 跨机器共享

如果要让**另一台机器**上的 client 连这个 hub：

```
[原 client 机器]                         [新 client 机器]
                                                                     
  已有:  ~/.d-pi/users/alice.json         
                                        # 把 alice.json 拷贝到新机器
                                        scp alice.json new-host:.d-pi/users/
                                                                     
  hub 已有:  auths/secrets/alice.json     
  (白名单不变，因为 publicKey 没变)       
                                                                     
                                        # 新机器直接跑
                                        d-pi connect alice@http://hub:39090
                                                                     
                                        # 自动 challenge-response
                                        # 拿新 session token
```

**不需要**在新机器上跑 `d-pi users create`（alice.json 复制过来即可，密钥对完整保留）。
**不需要**在 hub 跑 `d-pi allow-user`（公钥没变）。
**不需要**复制 token（新机器自己签一个）。

## 相关

- [概览](./overview) —— auth 整体流程（3 步 + 流程图）
- [用户管理 (users)](./users) —— 怎么 `d-pi users create` 拿 publicKey + privateKey
- [允许的用户](./allow-user) —— 怎么在 hub 端 `d-pi allow-user add` 加白名单
- [connect 命令](../getting-started/connect) —— `<user>@<url>` 语法详解

## 注意事项

- **不要**在文档或脚本里硬编码 token——它是 session 级别的，重新 connect 就失效
- **不要**把 `DPI_AUTH_TOKEN` 当成 API key 或长期 secret——它**是**会过期的
- token 泄露 = 失去 hub 控制权直到它自然过期（hub 重启/重启 auth-session 内存表清空）
- 当前 alpha 默认**开启** auth（`hub.ts:64` 无条件 `new AuthSessionManager()`），所有 client 必须能 challenge-response 或带有效 token
- 失败时 client TUI 会显示 401 错误——通常是 `allow-user` 名单没加、publicKey 拼写错、或 local user 文件路径不对
