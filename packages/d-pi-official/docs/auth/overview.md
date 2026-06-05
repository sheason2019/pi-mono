---
title: 概览
sidebar_position: 1
---

# 用户与认证

一句话：d-pi 用 **ed25519 challenge-response** 验证 client 身份，client 拿 ed25519 密钥对在本地存着，hub 只存公钥白名单。

d-pi 跟 pi coding-agent 的「单用户本地」模式不同，d-pi 的 hub 是**多人**可连的中心节点——所以必须验证每个 client 的身份。

## 三个角色，3 步流程

整个 auth 涉及两类数据，存放在**两个不同位置**：

| 数据 | 存哪 | 谁编辑 | 内容 |
|---|---|---|---|
| **Local user** | `~/.d-pi/users/<name>.json`（**$HOME** 下，**不是** workspace） | client 端 | ed25519 密钥对（publicKey + privateKey） |
| **Allowed user** | `<workspace>/auths/secrets/<name>.json`（**workspace** 下） | hub 端 | 客户端的 publicKey + `disabled` 标志 |

3 步端到端：

```
[client 机器]                              [hub 机器]
                                                                     
1. d-pi users create alice                   
   → ~/.d-pi/users/alice.json 生成          
      (publicKey + privateKey)              
   → stdout 打印 publicKey                   
                                                                     
2. (拷贝 publicKey 到 hub 机器)              d-pi allow-user add alice \
                                              --key <copied publicKey>
                                            → <workspace>/auths/secrets/
                                               alice.json 存 publicKey
                                            → 公开 pubkey 加入白名单
                                                                     
3. d-pi connect alice@http://hub:39090      
   → client 读 ~/.d-pi/users/alice.json      
   → POST /_hub/auth/challenge (publicKey)  
   → hub 查 allowed-users 找公钥匹配          
   → hub 返回 challenge + challengeId        
   → client 用 privateKey 签名 challenge      
   → POST /_hub/auth/session                 
      (publicKey + challengeId + signature)  
   → hub 验签 → 通过 → 返回 session token    
   → client 用 session token 当 Bearer      
   → 走完整 d-pi connect 流（tui + executor）
```

## 关键事实

- **Token 是短期 session token**，**只存在 hub 内存里**——hub 重启后旧 token 全失效，client 必须重新走一遍 challenge/response（reconnect 时 CLI 自动处理）
- **ed25519 私钥不离开 client 机器**——hub 永远看不到，只有 client 在每次 connect 时用它签 challenge
- **Auth 始终开启**，无 `--no-auth` 之类的 CLI 标志（`hub.ts:64` 无条件 `new AuthSessionManager(...)`）
- 失败原因通常是：allowed-user 名单没加 / 加错了 publicKey / 公钥拼写错——会收到 401

## 这一章的内容

- [用户管理 (users)](./users) —— 怎么创建 local user、密钥存哪、CLI 参数
- [允许的用户 (allow-user)](./allow-user) —— 怎么把 client 的 publicKey 加到 hub 白名单
- [DPI_AUTH_TOKEN](./dpi-auth-token) —— session token 的真实来源、为什么不需要手动拿

## 相关

- [connect 命令](../getting-started/connect) —— 客户端连 hub 怎么用 `<user>@<url>` 语法
