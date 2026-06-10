---
slug: /
---

# D-Pi Agent Teams

轻松编排具有你个人特色的 Agent 团队。

## d-pi 是什么

d-pi 是基于 [pi](https://github.com/earendil-works/pi-mono) serve 模式的多 agent 树形编排器，
在你已有的 pi coding-agent 之上加一层 hub-spoke 拓扑：

- **Hub** (`d-pi serve`)：一个常驻进程，调度所有 agent worker，持有拓扑和状态
- **Client** (`d-pi connect`)：你面前的 TUI，连到 hub 拿任务，agent 在你机器上跑工具
- **Agent worker**：hub 拉起的子进程，跟 pi agent 一样的 LLM 循环，但能调 d-pi 注册的额外工具

## d-pi 能解决什么问题

1. **多 agent 树形编排**：root agent 派生子 agent，子 agent 再派孙子 agent，
   天然适合「拆任务、并行做、汇总结果」的场景。工具: `create_agent` / `send_message` / `group_architecture` / `destroy_agent`。
2. **远程执行**：agent worker 跑在 hub 上，但工具执行（read / bash / write / ...）可以路由回 client 本机，
   透明的本地访问——工具: `remote_bash` / `remote_read` / `remote_ls` / `remote_grep` / `remote_find` / `remote_write` / `remote_edit`。
3. **跨 agent 寻址**：在 client TUI 输入 `connect <id>` 即可把消息定向派给指定 agent，
   不打断当前对话的上下文。
4. **数据源 (Sources)**：把外部命令的输出订阅为 agent 上下文流。Source 进程跑在 hub 机器上，stdout 必须按 [JSONRPC 2.0 notification](https://www.jsonrpc.org/specification) 格式输出（每行一条 `{"jsonrpc":"2.0","method":"<event>","params":{...}}`），hub 严格 parse 后才转发给订阅的 agent。Notification 的 `params` 支持两个 per-event 字段:
   - `deliverAs`: `"steer"` (中断当前 turn) / `"followUp"` (默认, queue到当前 turn 之后) / `"prompt"` (触发新 turn, `triggerTurn: true`)
   - `drainMode`: `"all"` (默认, batch 队列消息) / `"one-at-a-time"` (每条单独 turn, 适合交互事件)
   完整闭环: `create_source` → `subscribe_source` → `unsubscribe_source` → `destroy_source`。
5. **认证**：hub 自带 bearer token，多用户共享一个 hub 时按 allowed-users 白名单控制。

## 下一步

先看 [快速上手 → 安装](./getting-started/install) 5 分钟跑起来。

想直接查工具列表，跳到 [参考 → Agent 工具](./reference/tools)。
