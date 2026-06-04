---
title: 第一次会话
sidebar_position: 5
---

# 第一次会话

一句话：跑通「init → serve → connect → 让 agent 读一个文件」的最小闭环。

## 准备

完成 [安装](./install) 和 [初始化 workspace](./init)。

## 步骤

**1. 起 hub**（一个终端）

```bash
cd ~/my-project
d-pi serve
```

等看到 `Listening on http://localhost:39090`。

**2. 拿 auth token**（另一个终端）

hub 第一次启动会为当前 user 生成一个 token：

```bash
cd ~/my-project
cat .dpi/hub-state.json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['tokens'][0])"
```

复制输出，下一步用。

**3. 连 client**（第三个终端，或退出 hub 之前后台）

```bash
cd ~/my-project
DPI_AUTH_TOKEN=<刚才拿的 token> d-pi connect
```

进入 pi TUI。

**4. 让 agent 干活**

在 TUI 里输入：

```
请用 remote_read 读一下当前目录的 README.md，告诉我里面有什么
```

agent 会调 `remote_read` 工具，路由到你的 executor 子进程（在你机器上跑 `cat README.md`），
把结果回给 LLM，LLM 给你摘要。

**5. 退出**

TUI 里按 `Ctrl+C`。

## 预期结果

成功路径下你应该看到：
- hub 终端打出 `client connected`
- client 终端进入 TUI，能正常打字
- agent 调 `remote_read` 几秒内返回内容
- 退出时两个终端都干净退出，无 hang、无 kitty 协议污染

## 常见问题

**Q: 401 Unauthorized。**
A: `DPI_AUTH_TOKEN` 没传或传错，重新跑 step 2 拿 token。

**Q: 卡在 `[d-pi connect] TUI child exited` 不退。**
A: 老版本 bug；当前 alpha 已修，确保 `@sheason/d-pi >= 0.6.0-alpha.1`。

**Q: 终端退出后光标没了 / 键入变乱码。**
A: kitty 协议没 pop；当前 alpha 已修；如遇老版本参考 [故障排查](#)。

## 相关

- [远程执行 → remote tools](../remote-execution/remote-tools)
- [多 Agent 编排 → 概览](../multi-agent/overview)
