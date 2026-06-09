---
title: 第一次会话
sidebar_position: 5
---

#第一次会话

一句话：跑通「init → serve → users create → allow-user → connect → 让 agent读一个文件」的最小闭环。

##准备

完成 [安装](./install) 和 [初始化workspace](./init)。

##步骤

**1. 起 hub**（一个终端）

```bash
cd ~/my-project
d-pi serve
```

等看到 `Listening on port39090`。

**2. 创建 local user**（另一个终端，**client机器**）

```bash
d-pi users create alice --description "Alice's laptop"
```

预期输出：

```
Created local user alice
description: Alice's laptop
publicKey: MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI
```

复制 `publicKey` 那行（**没有** `ed25519:` 前缀，base64url编码）。这一步生成 ed25519密钥对，privateKey存在 `~/.d-pi/users/alice.json` (mode `0o600`)。

**3. 加 user到 hub白名单**（**hub机器**的 workspace根）

```bash
cd ~/my-project
d-pi allow-user add alice --key MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI
```

预期输出：

```
Allowed user alice
description: Alice's laptop
publicKey: MCowBQYDK2VwAyEAeuOMC4952ZbL8RF09jTXlWwi1jtS-yDImXFC7wzOdYI
```

`publicKey`存到 `<workspace>/auths/secrets/alice.json`，alice 现在可以 connect 了。

**4. 连 client**（**client机器**，回到 alice 用户）

```bash
cd ~/my-project
d-pi connect alice@http://localhost:39090
```

CLI内部走 ed25519 challenge-response（client读 `~/.d-pi/users/alice.json` privateKey → POST challenge →签名 → POST session →拿 token → 用 token 连 hub）。 **不需要**用户预先 export `DPI_AUTH_TOKEN`。

进入 pi TUI。

**5. 让 agent干活**

在 TUI里输入：

```
请用 remote_read读一下当前目录的 README.md，告诉我里面有什么
```

agent会调 `remote_read`工具，路由到你的 executor子进程（在你机器上跑 `cat README.md`），
把结果回给 LLM，LLM给你摘要。

**6.退出**

TUI里按 `Ctrl+C`。

##预期结果

成功路径下你应该看到：
- hub终端打出 `Restoring agent "root" from root/` + `Listening on port39090`
- client终端进入 TUI，能正常打字
- agent调 `remote_read`几秒内返回内容
-退出时两个终端都干净退出，无 hang、无 kitty协议污染

##常见问题

**Q:401 Unauthorized / "User 'alice' is not in allow-user list"。**
A: `allow-user add alice --key <publicKey>` 没跑，或 publicKey拼写错（注意大小写敏感，没有 `ed25519:` 前缀）。重新跑 step3。

**Q: 卡在 `[d-pi connect] TUI child exited` 不退。**
A: 老版本 bug；当前 alpha 已修，确保 `@sheason/d-pi >=0.6.0-alpha.1`。

**Q:终端退出后光标没了 /键入变乱码。**
A: kitty协议没 pop；当前 alpha 已修；如遇老版本先 `reset` 清屏。

**Q: 我不想每次都输 `alice@http://...`。**
A: 把 hub URL 设到环境变量或写在 shell alias。 `DPI_AUTH_TOKEN` 可手动设（跳过 challenge-response），但 hub 重启后失效。

## 相关

- [用户与认证 →概览](../auth/overview) ——3步 auth流程图
- [远程执行 → remote tools](../remote-execution/remote-tools)
- [多 Agent编排 →概览](../multi-agent/overview)
